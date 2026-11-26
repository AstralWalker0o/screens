# App update manager (Android TV boxes)

Keeps sideloaded apps on Android TV boxes up to date: the Screens Launcher, apps uploaded to the
library, and apps published as GitHub releases (Jellyfin, SmartTube, …). Apps installed from
Google Play are shown but left to Play.

Code: `central/src/worker/updates/` (Worker + SiteHub), `central/src/shared/updates.ts` (types and
the decision logic shared with the dashboard), `central/src/worker/api/updates.ts` (REST),
`central/src/ui/pages/Updates.tsx` + `pages/updates/` (dashboard), `central/migrations/0005_updates.sql`.

## What the owner sees

- **Updates** page: apps with updates first, then every sideloaded app with the version on each box,
  grouped by site; per-app source and policy; rollouts and update jobs; maintenance windows, canary
  box and build type (processor) per box. Buttons: *Check for updates* (GitHub now), *Re-read boxes*,
  and *Update* per app / site / box.
- **Overview**: an "App updates" card.
- **Device → Apps**: "N app updates ready" with one-click updates, and per-app badges
  (Update x.y, Google Play, Update blocked, Pinned).
- Alerts: a failed update (warning), a GitHub release signed with a different key (warning), a
  GitHub source failing 3 times in a row (warning), a new version available (info).

## Where builds come from

Everything installable is an APK in the library (`apks` + R2). Screens reads each one itself
(`update_apk_info`): package and long `versionCode` from the binary manifest, native ABIs from
`lib/<abi>/`, and its signing certificates from the APK Signing Block (v2, v3, v3.1 with
proof-of-rotation lineage) or the JAR signature. Reading uses R2 range reads, so a 100 MB APK is
never loaded into memory. A library APK whose manifest names a different package than the one typed
at upload is never offered.

1. **Library**: uploads on the Library page. New uploads are read within a minute (cron) or when the
   Updates page loads.
2. **GitHub releases** (`update_sources`, one per package): `owner/repo`, a general file-name
   pattern (`*.apk`) and optional per-ABI patterns (`arm64-v8a: *arm64*.apk`,
   `armeabi-v7a: *armeabi-v7a*.apk`), optional pre-releases. Checked every 6 h (two sources per
   minute at most from the cron) and on demand.
3. **Screens Launcher**: built in. `tools/release-launcher.sh` publishes it to the library.

### GitHub fetch safety

- Unauthenticated by default; an optional `GITHUB_TOKEN` Worker secret raises the rate limit. The
  token is only ever sent to the API host, never to download hosts.
- Conditional requests with the stored ETag (a 304 costs nothing). When GitHub says the limit is
  used up (403/429 with `x-ratelimit-remaining: 0` or `retry-after`), all checks pause until the
  reset time (at most 2 h), stored in `update_state`.
- Downloads follow redirects by hand. Every hop must be https on `github.com`, `api.github.com`,
  `objects.githubusercontent.com`, `release-assets.githubusercontent.com` or
  `github-releases.githubusercontent.com` (no credentials in URLs, no other ports).
- Only `.apk` assets, at most 200 MB, at most 4 per release; the response must be 200 with an APK /
  octet-stream / zip content type and a `content-length` equal to the size GitHub listed. The body
  is streamed into R2 through a byte counter while its SHA-256 is computed (`crypto.DigestStream`);
  JSON answers are capped at 2 MB.
- The APK must be a readable, signed APK of **the source's package**. The first import teaches the
  source its trusted signing key; later releases must be signed by it or carry a v3
  proof-of-rotation from it (then the new key becomes trusted). Anything else is deleted from R2,
  not imported, and raises an alert. *Trust the new key* (Updates → app → settings) resets this.
- `GITHUB_API_BASE` (tests only) points sources at a stand-in; http is allowed for that one host only.

## Policies

`update_policies`: per package a fleet default and per-site overrides, resolved site → fleet →
**notify**.

- **auto**: installed in the site's maintenance window (`update_sites`, default 03:00–05:00 in the
  site's time zone; windows may wrap midnight), one rollout at a time per site.
- **notify**: shown as ready, with one-click update.
- **pin**: kept on the current version. Choosing a pinned box by hand still updates it.

## Which build a box gets

From `ro.product.cpu.abilist` (read over adb, `update_devices`): the newest compatible build; for
equal versions the one built for the box's primary ABI (smallest), then a universal one. The owner
can choose a build type per box (e.g. 32-bit builds on a 64-bit box). Unknown processors only get
builds without native code until the box has been read. `minSdk` is respected.

Per box and app the state is one of: update, current, ahead (never downgraded), store (Google Play
or Amazon Appstore installed it), pinned, incompatible, signer_mismatch, no_source, unknown.

## Reading boxes (adb shell, no new gateway ops)

All commands start with an `echo @@upd=<kind>` marker (`central/src/worker/updates/device.ts`).

- **probe** (every 6 h per online box, and *Re-read boxes*): ABIs, SDK, and for each third-party
  package its `versionCode`, `installerPackageName` and the `dumpsys` signature hash
  (Java `Arrays.hashCode` of the certificate) → `update_device_apps`.
- **pre** (right before each install): live version and installer, plus whether the box is in use:
  `dumpsys media_session` shows something playing, or the screen is awake (`mWakefulness=Awake`)
  with an app other than a launcher in front.
- **apktail / apkpart**: the end of the installed `base.apk` (base64, ≤192 KB per read) to read the
  real signing certificate (SHA-256) of the installed app; falls back to the dumpsys hash.
- **ver**: version after install. **launch** (canary only): `monkey` with the Leanback (else
  launcher) category, wait 5 s, check the process, the resumed activity and the crash log, then
  bring the home screen back with a HOME *intent* (a HOME key press would wake a sleeping box and,
  through HDMI-CEC, the TV).

## Rollouts (`update_rollouts`, run by each SiteHub)

The hub alarm (every minute while the gateway is online) starts background work without blocking
the alarm: due probes, then one step of the oldest active rollout (manual before automatic), and
every 5 minutes, inside the window, plans one automatic rollout.

1. Boxes are ordered: the site's chosen canary first (if online), then online boxes by name.
2. **Canary**: install, verify the new version, open the app (the Screens Launcher instead
   answers a STATUS broadcast after its settings are re-pushed). If the canary is busy, offline or
   already current, the next free box becomes the canary.
3. **The rest**, one at a time: install and verify the version.
4. Each box install is a `jobs` row (`kind = app_update`) with `{package, from, to, apk_id,
   rollout_id, canary}` and a plain-English result.
5. Busy or offline boxes wait and are retried every 5 minutes (24 tries, auto rollouts only inside
   the window). A failed canary stops the rollout before any other box is touched; two failures stop
   it too. Unfinished boxes are given up after 3 days.
6. An automatic rollout of a version runs at most once a day per site, and never again for 7 days
   after it failed or was cancelled.

Before every install the box is re-read: if it already has this version or newer it is skipped
(never downgraded); store-installed apps are skipped; a different signing key fails the box with
"Screens never uninstalls to force an update". Installs use `adb.install` with the signed R2 URL and
the SHA-256 (verified by the gateway) and flags `-r` only: no `-d` (downgrade) and no `-g` (silently
granting new permissions). Nothing in the update manager ever uninstalls.

## API

See the "App updates" section of [API.md](API.md).

## Tests

- `central/test/updates.test.ts`: APK inspection on real APKs (`test/fixtures/updates/*.apk`, built
  by `build.sh` with aapt2 + apksigner; expected digests from keytool / Java).
- `central/test/updates.logic.test.ts`: windows and DST, policies, asset matching, build choice,
  states, rollout order, adb output parsers, GitHub host allowlist.
- `central/test/updates.flow.test.ts`: GitHub import, staged rollouts, signer mismatch, crash on
  launch, busy boxes, automatic planning, against the real migrations (node:sqlite) and fake boxes.
- `tools/e2e/e2e.py` section "app updates": the real gateway and the simulated Shield
  (`tools/sim/sim.py` now installs real APKs and enforces signer/downgrade rules), with a stand-in
  GitHub on 127.0.0.1:8791 (`GITHUB_API_BASE` in `wrangler.e2e.jsonc`). Restart a running
  `wrangler dev` so it picks that variable up.
