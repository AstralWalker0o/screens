# Screens Launcher v2: contract between the Android app and the cloud

Launcher v2 turns `au.supercluster.screens.launcher` from a kiosk grid into a
full Android TV home screen in the style the operator built by hand with public
tools (Projectivy Launcher with Button Mapper). It has a full-bleed wallpaper, a
clock and status icons top right, and titled rows of large app cards that zoom
on focus. **Everything is configured centrally in Screens and pushed down over
adb.** Nothing is configured on the box. The app still has **no INTERNET
permission**.

This file is the source of truth for both sides. It extends LAUNCHER.md, so
v1 delivery, the STATUS broadcast, the welcome screen and kiosk all keep
working. The Android app must accept v1 configs unchanged.

## 1. Delivery

### 1.1 Assets (images)

Images (wallpaper, custom card art) are content-addressed by lowercase hex
SHA-256. The hub pushes each asset **before** sending a config that references
it:

```sh
# 1. gateway adb.push (signed R2 URL, sha256-verified by the gateway):
#    → /data/local/tmp/screens-asset-<sha>.<ext>
# 2. hand it to the app through its ContentProvider (protected by android.permission.DUMP):
content write --uri content://au.supercluster.screens.launcher.assets/<sha>.<ext> < /data/local/tmp/screens-asset-<sha>.<ext>
rm -f /data/local/tmp/screens-asset-<sha>.<ext>
# 3. confirm (content write always exits 0, and verification happens after it returns):
content query --uri content://au.supercluster.screens.launcher.assets/<sha>.<ext>
#    → "Row: 0 sha256=<sha>, bytes=<n>" means stored and verified; "No result found." means
#      rejected (the reason is in STATUS last_error)
```

- Provider authority: `au.supercluster.screens.launcher.assets`, exported, with
  `android:readPermission` and `android:writePermission` set to
  `android.permission.DUMP`. Only the adb shell can use it.
- Path segment: `<64 hex>.<jpg|png|webp>`. Anything else is rejected.
  (The app also accepts upper-case hex digits and extensions and normalises
  them to lower case. The cloud always sends lower case.)
- The app writes to internal storage (`files/assets/`), verifies the SHA-256
  after the write and deletes the file on a mismatch.
- Assets not referenced by the current config are deleted 24 h after a new
  config is applied.
- Limits: 8 MB per asset, 64 MB total. Exactly: at most **8,388,608 bytes**
  per asset and **67,108,864 bytes** in total.
- Asset list query:
  `content query --uri content://au.supercluster.screens.launcher.assets/`
  prints one row per stored asset as `Row: N sha256=<hex>, bytes=<n>`.

#### How `content write` behaves on real devices (Android 9–15)

These points were checked against the AOSP sources of the `content` command
(`cmds/content/…/Content.java`) and the platform SELinux policy. The cloud
must follow them:

- **Keep the `<` redirect inside the device shell command**, exactly as shown
  above (one `adb shell` command string). The redirect then happens on the
  device, so stdin is the pushed file. Don't stream bytes through `adb shell`'s
  own stdin, because older adb shell protocols never deliver EOF.
- `content write` calls the provider's `openFile(uri, "w")` and copies stdin
  into the descriptor it gets back (Android 9 to 14 all do this). **It always
  exits with status 0.** On failure it prints
  `Error while accessing provider:au.supercluster.screens.launcher.assets`
  and a Java stack trace to stderr, for example
  `java.io.FileNotFoundException: invalid asset path: …`,
  `… asset store full (67108864 bytes)` or `… too many uploads in progress`
  (at most 4 at once).
- The SHA-256 check happens **after** the writer closes its end, so a
  mismatch, an over-8 MiB upload, or a store that is full can't be reported
  by `content write` itself. **Confirm every push with `content query`**:
  the asset counts as delivered only once its `sha256=` row is listed. The
  query first waits up to 10 s for uploads still being verified (STATUS waits
  up to 3 s), so running it straight after `content write` gives the final
  answer. The reason for a rejection is in STATUS `last_error`.
- The provider hands the shell the write end of a **pipe**, not a file. From
  Android 14 the shell's SELinux domain may no longer write app data files
  through a passed descriptor, while app-to-app pipes are allowed on every
  version. The cloud needs to do nothing about this; it is why a write can't
  be verified synchronously.
- An upload that never finishes is aborted after 120 s.
- With no stored assets, `content query` prints `No result found.`.
- A single asset can be checked with
  `content query --uri content://au.supercluster.screens.launcher.assets/<sha>.<ext>`
  (or `/<sha>`): one row or `No result found.`.
- An asset can be removed early with
  `content delete --uri content://au.supercluster.screens.launcher.assets/<sha>.<ext>`
  (it prints nothing; check with `content query`). This is optional; cleanup
  is automatic.
- Pushing the same SHA again (under any extension) replaces it and restarts
  its 24 h clock. One file is kept per SHA.

Cleanup and the total limit, precisely:

- An asset not referenced by the current config (`home.wallpaper.asset` and
  `home.tiles.*.asset`) is deleted once **both** the last config apply and the
  asset's own write are at least 24 h old. That way assets pushed ahead of a
  config aren't lost. Cleanup runs on every provider call, every CONFIG or
  STATUS broadcast and whenever the home screen comes back to the front. A box
  whose clock isn't set yet (before 2021) never deletes anything.
- If an upload would take the total over 64 MiB, the app first evicts
  unreferenced assets written more than 1 h ago, oldest first. If it still
  doesn't fit, the upload is rejected with `asset store full`. Referenced
  assets are never evicted.

### 1.2 Config

Config is unchanged from v1: an `am broadcast` to `.ConfigReceiver` with
`--es config_b64 <base64 JSON>`. The result is `ok:<sha256 of JSON>` or
`error:<message>`.

The config JSON must stay **under 48 KB** before base64. A config that
references a missing asset is still **accepted**: the app shows the fallback
(plain gradient background, or the app's own banner) and reports the missing
SHAs in STATUS. (The app itself accepts up to 64 KB, as in v1. The 48 KB
limit leaves room for the `am broadcast` command line.) When the missing
asset arrives later, the home screen picks it up without another config.

### 1.3 STATUS (extended)

`data="status:{...}"` gains the following fields:

```json
{ "version": "2.0.0", "version_code": 20000, "config_sha": "…", "config_v": 2, "is_home": true,
  "assets": ["<sha>", "…"], "missing_assets": ["<sha>"], "last_error": null }
```

- Keys come in this order. Every field is always present.
- `config_v` is the stored config's `v` (1 or 2), or `null` when no config is
  stored (then `config_sha` is `null` too).
- `assets` lists every stored asset, sorted. `missing_assets` lists the SHAs the
  stored config references (`home.wallpaper.asset`, `home.tiles.*.asset`) that
  aren't stored, sorted.
- `last_error` is a one-line string (at most 300 characters) or `null`. It is
  set by a rejected CONFIG (`config: <message>`), a rejected asset upload
  (`asset <sha>: sha256 mismatch (received <n> bytes with sha256 <hex>)`,
  `asset <sha>: larger than 8388608 bytes`, `asset <sha>: asset store full (67108864 bytes)`,
  `asset <sha>: upload timed out`) or a stored asset that won't decode
  (`asset <sha>: cannot decode image`). A CONFIG that applies clears it, unless
  it is about an asset that config references and that is still missing. A
  successful upload of the asset it names also clears it.
- STATUS first waits up to 3 s for uploads still being verified, so it
  reflects a `content write` that has just returned.

**Parsing note for the cloud:** `am broadcast` prints the result as
`Broadcast completed: result=1, data="<data>"` **without escaping** the
quotes inside `<data>` (checked in `ActivityManagerShellCommand` on Android 9,
11 and 14). The JSON after `status:` is therefore printed with bare `"`. Take
everything from `data="` up to the **last** `"` on that line, for example with
`/Broadcast completed: result=(-?\d+)(?:, data="(.*)")?\s*$/m`, and don't
unescape it. `last_error` never contains a newline.

### 1.4 Making it home

The v1 behaviour is unchanged: `cmd package set-home-activity …`, and the stock
launcher can optionally be disabled. With v2 installed as home, Button Mapper
or similar apps are no longer needed.

## 2. Config JSON v2

```json
{
  "v": 2,
  "site_name": "Theatre",
  "accent": "#4F8EF7",
  "home": {
    "wallpaper": { "asset": "<sha256>", "ext": "jpg", "dim": 0.25 },
    "top_bar": { "clock": true, "clock_24h": false, "date": false, "network": true, "settings": true },
    "rows": [
      { "id": "featured", "title": "InterNik", "icon": "bookmark", "card": "banner", "size": "large",
        "apps": ["org.jellyfin.androidtv"] },
      { "id": "media", "title": "Media", "icon": "media", "card": "banner", "size": "medium",
        "apps": ["au.com.kayo.ott", "com.netflix.ninja", "com.plexapp.android", "com.amazon.amazonvideo.livingroom", "com.google.android.youtube.tv"] }
    ],
    "all_apps": { "enabled": true, "title": "All apps" },
    "hidden": ["com.android.vending"],
    "tiles": { "com.plexapp.android": { "label": "Plex", "asset": "<sha256>", "ext": "png" } },
    "focus": { "scale": 1.12, "label": "focused" }
  },
  "kiosk":   { "enabled": false, "allowed": [], "pin_sha256": null },
  "pinned":  [],
  "welcome": { "enabled": false, "show_on_boot": false, "title": "", "message": "", "wifi": null, "sections": [], "contact": "" }
}
```

Field rules (both sides validate; the app ignores unknown fields):

| Field | Rule |
|---|---|
| `home` | Optional. Absent → v1 behaviour (grid, `pinned` first). |
| `home.wallpaper` | `null` → built-in dark gradient. `dim` is 0–0.8, a black overlay so text stays legible. `ext` is `jpg`, `png` or `webp`. |
| `home.top_bar` | All booleans. `settings` shows a gear that opens Android Settings (PIN-gated when kiosk is on). `network` shows a Wi-Fi/Ethernet glyph. |
| `home.rows[]` | 1–12 rows. `id` matches `[a-z0-9_-]{1,32}`, unique. `title` is ≤ 40 chars and may be empty. `icon` is one of `bookmark`, `media`, `star`, `tv`, `music`, `games`, `kids`, `settings`, `apps`, `none`. `card` is `banner` (16:9 app banner, the Projectivy look), `icon` (square icon on a tinted card) or `poster` (2:3). `size` is `small`, `medium` or `large`. `apps` lists 0–40 package names in display order; packages not installed are skipped silently. |
| `home.all_apps` | If enabled, a final row lists every launchable app that isn't hidden and isn't already in a row, sorted by label. |
| `home.hidden` | Packages never shown anywhere, including All apps. |
| `home.tiles` | Optional per-package overrides: `label` (≤ 40 chars) and/or custom card art `asset` + `ext`. |
| `home.focus.scale` | 1.0–1.25. `label` is `always`, `focused` or `never` (whether the app name shows under the card). |
| `kiosk` / `pinned` / `welcome` | Exactly as in v1. With `kiosk.enabled`, only `allowed` packages appear in any row (and All apps), and the Settings gear needs the PIN. |

Package names match `^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$`.

### 2.1 How the app validates and fills in v2 (2.0.0)

One bad value rejects the whole config with `error:<field path>: <problem>`,
for example `error:home.rows[1].id: duplicate id "media"`. The previous config
stays in place, exactly as in v1.

- `v` must be `1` or `2`. In a **v1** config, `home` is an unknown field and
  is ignored. In a **v2** config, the package rule above applies to **every**
  package list (`kiosk.allowed`, `pinned`, `rows[].apps`, `hidden`, `tiles`
  keys). It is slightly wider than v1's rule, which v1 configs keep. Lists hold at
  most 500 entries (`rows[].apps` at most 40), and duplicates are dropped.
- `home: null` or no `home` → the v1 grid. If `home` is present, `home.rows`
  must be present with 1–12 rows. Each row must be an object with an `id`, and
  ids are unique.
- Enumerations (`icon`, `card`, `size`, `focus.label`) are exact, lower case
  and strict: an unknown value is an error. `asset` is 64 hex characters (any
  case, stored lower case). `ext` is `jpg`, `png` or `webp` (any case).
  `asset` and `ext` must come together. `dim` (0–0.8) and `focus.scale`
  (1.0–1.25) out of range are errors.
- Display text (`rows[].title`, `all_apps.title`, `tiles.*.label`) is cleaned
  and truncated like v1 text: control characters removed, then cut to 40
  characters with "…". It is never an error.
- `tiles.<pkg>` may be `{}` or `null`, which overrides nothing.

Defaults when a field is absent or `null`:

| Field | Default |
|---|---|
| `home.wallpaper` | none: built-in dark gradient tinted by `accent` |
| `home.wallpaper.dim` | `0.25` |
| `home.top_bar.clock` / `network` / `settings` | `true` |
| `home.top_bar.date` | `false` |
| `home.top_bar.clock_24h` | follows the TV's own 12/24-hour setting |
| `rows[].title` | empty (icon only, or no header text) |
| `rows[].icon` / `card` / `size` | `none` / `banner` / `medium` |
| `home.all_apps` | `{ "enabled": true, "title": "" }`; an empty title shows "All apps" |
| `home.focus` | `{ "scale": 1.12, "label": "focused" }` |

## 3. Look and behaviour (Android)

- **Wallpaper** fills the screen. A dim overlay, plus a soft gradient at the
  left and bottom, keeps titles readable.
- **Top right:** network glyph, settings gear (focusable) and a large thin
  clock (`h:mm`, or `HH:mm` for 24 h).
- **Rows:** a small row header (icon + title) sits above each row's left edge.
  Cards scroll horizontally. The focused row moves to a fixed vertical
  position about 40 % down the screen, and the rows above fade out (the
  Projectivy feel).
- **Card art:** a `banner` card shows the app's TV banner
  (`PackageManager.getApplicationBanner` / `getActivityBanner`). Without one,
  it shows the app icon centred on an accent-tinted card. A custom `tiles`
  asset takes priority.
- **Focus:** a smooth scale animation (`focus.scale`, about 150 ms), a white
  2 dp outline and a soft glow shadow. The label shows under the focused card
  per `focus.label`.
- **D-pad:** left/right moves within a row, up/down moves between rows and
  keeps the column where possible. OK launches the app. Back on home does
  nothing. Up from the first row reaches the top bar.
- **Performance:** banner bitmaps are decoded once and cached, and there's no
  jank on a 2019 Shield.
- The welcome screen and the kiosk PIN dialog work as in v1.

### 3.1 How 2.0.0 implements it

- **Card sizes** (dp; a 1080p TV is 960 × 540 dp):

  | `card` | small | medium | large |
  |---|---|---|---|
  | `banner` (16:9) | 128 × 72 | 160 × 90 | 272 × 153 |
  | `icon` (1:1) | 80 | 104 | 136 |
  | `poster` (2:3) | 96 × 144 | 120 × 180 | 156 × 234 |

  All apps uses small banners and the `apps` icon. Its header shows
  `all_apps.title`, or "All apps" when that is empty.
- **Pinning:** the focused row's card top edge sits 40 % down the screen. The
  first row starts there too, so the space above it is wallpaper. Rows above
  the focused one fade to invisible; the headers of the other rows show at
  55 % opacity.
- **Art order:** the `tiles` asset (if stored and decodable), then for
  `banner` cards the activity banner, then the application banner, then the
  app icon on an accent-tinted card with the app's name (the name inside the
  card is left out when `focus.label` is `always`). `icon` and `poster` cards
  use the tiles asset or the icon. Art is decoded at the exact pixel size of
  the card and cached (LRU, at most 64 MiB). The wallpaper is decoded at screen
  size, at most 1920 px on the long side, and centre-cropped. EXIF rotation
  isn't applied, so the cloud should send upright images.
- **Wallpaper overlay:** `dim` black over the image, plus a left gradient
  (50 % → 0 over 55 % of the width) and a bottom gradient (0 → 65 % over the
  lower 45 %). With no image, there's no dim.
- **D-pad:** up/down keeps a sticky column, so passing through a shorter row
  doesn't lose it. Left/right stop at the row ends. Up from the first row goes
  to the gear, and down from the gear returns to the row you left. OK launches
  on key release, and only for a press that began on that card. Home while on
  home closes the PIN dialog and returns to the first card.
- **Settings gear and kiosk:** without kiosk, the gear opens Android Settings.
  With kiosk and a PIN, it opens the v1 PIN dialog; with kiosk and
  `pin_sha256: null`, it opens Settings directly. If kiosk is on and
  `top_bar.settings` is `false`, the clock becomes focusable and a long press
  on OK asks for the PIN (v1's escape hatch). With both the gear and the clock
  hidden in kiosk, there is no way into Settings from the home screen.
- **Network glyph:** Wi-Fi with signal bars, Ethernet, or crossed-out Wi-Fi for
  no network. Reading this needs `ACCESS_NETWORK_STATE`, a normal
  install-time permission that grants no network access. The app still has no
  `INTERNET` permission.
- **No apps to show** (for example, kiosk with nothing allowed installed): the
  screen shows "No apps are available on this TV yet." and focus goes to the
  gear.
