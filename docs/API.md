# Screens central REST API (dashboard ↔ Worker)

Everything under `/api/*` sits behind Cloudflare Access. The Worker re-verifies
the Access JWT on every request. Types are in `central/src/shared/types.ts`.
Errors are `{ "error": "code", "message": "human text" }` with a 4xx/5xx status.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/me` | | `Me` |
| GET | `/api/version` | | `VersionInfo`: app version + build, latest gateway/launcher versions and how many are up to date. Release notes are bundled in `src/shared/releases.ts`. |
| GET | `/api/overview` | | `Overview` |
| GET | `/api/clients` | | `Client[]` |
| POST | `/api/clients` | `{name, contact?, notes?}` | `Client` |
| PATCH / DELETE | `/api/clients/:id` | partial | `Client` / `{ok}` |
| GET | `/api/sites?client_id=` | | `SiteSummary[]` |
| POST | `/api/sites` | `{client_id, name, kind, timezone, address?}` | `SiteDetail` |
| GET | `/api/sites/:id` | | `SiteDetail` |
| PATCH | `/api/sites/:id` | partial incl. `settings` (partial merge) | `SiteDetail` |
| DELETE | `/api/sites/:id` | | `{ok}` |
| POST | `/api/sites/:id/enroll` | | `EnrollResult` (one-time gateway install command) |
| GET | `/api/sites/:id/gateway` | | `Gateway & {logs: string[]}` |
| POST | `/api/sites/:id/gateway/:action` | action ∈ `restart`, `update`, `revoke` | `{ok}` |
| POST | `/api/sites/:id/discover` | | `Discovered[]` (runs a scan, takes about 5–10 s) |
| GET | `/api/sites/:id/discovered` | | `Discovered[]` |
| POST | `/api/sites/:id/adopt` | `{ip, kind, name, room?, port?}` | `Device` |
| POST | `/api/sites/:id/discovered/:ip/ignore` | | `{ok}` |
| GET | `/api/sites/:id/apps` | | `{package, label, system, category, risk, devices, kinds[]}[]`, the union of apps on the site's devices |
| POST | `/api/sites/:id/guest-reset` | `{device_ids?: string[]}` | `{results: {device_id, ok, detail}[]}` |
| GET | `/api/sites/:id/sonos` | | `SonosSiteOverview`: every Sonos group/room at the site, read live through one reachable speaker (state, track, art, group + room volumes, which rooms are adopted) |
| GET | `/api/sites/:id/mdns` | | `{config: MdnsConfig, status: MdnsStatus \| null, interfaces: GatewayInterface[]}` |
| PUT | `/api/sites/:id/mdns` | `MdnsConfig` | `{ok}` |
| GET | `/api/sites/:id/network` | | `NetworkState`: `{supported, gateway_online, config: NetConfig, status: NetIfaceStatus[], errors, host: GatewayInterface[], updated_at}` (asks the gateway live when online) |
| PUT | `/api/sites/:id/network` | `NetConfig` `{interfaces: [{kind: "vlan"\|"existing", parent?, vlan?, name?, mode: "dhcp"\|"static", address?, label?}]}` | `NetworkState` after the gateway applied it (saved and applied on reconnect if the gateway is offline) |
| GET | `/api/sites/:id/dns/log?device_id=&q=&action=&limit=200&before=` | | `DnsLogEntry[]` (newest first) |
| GET | `/api/sites/:id/dns/summary?hours=24` | | `DnsSummary` |
| WS | `/api/sites/:id/live` | | stream of `LiveEvent` JSON frames |
| GET | `/api/devices?site_id=&kind=` | | `Device[]` |
| GET | `/api/devices/:id` | | `Device` |
| PATCH | `/api/devices/:id` | `{name, room, tags, ip, port, dns_mode, dns_policy, dns_allow, dns_block}` | `Device` |
| DELETE | `/api/devices/:id` | | `{ok}` |
| POST | `/api/devices/:id/command` | `CommandRequest` | `CommandResult` |
| POST | `/api/devices/bulk` | `BulkCommandRequest` `{device_ids, command, args}` (no `shell`). The pseudo-command `dns_mode` with `{mode}` updates DNS mode for all of them. | `BulkCommandResult` |
| GET | `/api/devices/:id/apps` | | `DeviceApp[]` (cached inventory; `command: "apps"` refreshes) |
| GET | `/api/devices/:id/privacy` | | `DevicePrivacy` |
| PUT | `/api/devices/:id/privacy/checklist` | `{key, done}` | `{ok}` |
| GET | `/api/devices/:id/screenshot` | | `image/jpeg` (latest) or 404 |
| GET | `/api/devices/:id/sonos/art?path=/getaa?…` | | Sonos album art for speaker-relative URLs (`now_playing.art`, queue/favourite `art` starting with `/`), fetched from the speaker through the gateway; raster images only, cached ~1 h per site. Absolute `https://` art loads directly. 404 when there is none. |
| GET | `/api/privacy` | | `PrivacyOverview` |
| GET | `/api/dns/domains?q=&category=&site_id=&days=7&limit=200` | | `DnsDomainStat[]` |
| GET | `/api/dns/rules` | | `DnsRule[]` |
| POST | `/api/dns/rules` | `DnsRule` (no created_at/source) | `DnsRule` |
| DELETE | `/api/dns/rules?domain=&scope_type=&scope_id=` | | `{ok}` |
| GET | `/api/dns/lists` | | `{lists: DnsList[], builds: DnsPolicyBuild[]}` |
| PATCH | `/api/dns/lists/:id` | `{enabled?, policies?}` | `DnsList` |
| POST | `/api/dns/rebuild` | | `{builds: DnsPolicyBuild[]}` (refetch lists, recompile, push) |
| GET | `/api/apks` | | `Apk[]` |
| POST | `/api/apks` | multipart `file`, `package?`, `label?`, `notes?` | `Apk` |
| DELETE | `/api/apks/:id` | | `{ok}` |
| GET / POST | `/api/app-policies` | `AppPolicy` | `AppPolicy[]` / `AppPolicy` |
| PATCH / DELETE | `/api/app-policies/:id` | | |
| GET / POST | `/api/automations` | `Automation` | |
| PATCH / DELETE | `/api/automations/:id` | | |
| POST | `/api/automations/:id/run` | | `{ok, jobs: Job[]}` |
| GET | `/api/jobs?site_id=&device_id=&limit=` | | `Job[]` |
| GET | `/api/alerts?open=1` | | `Alert[]` |
| POST | `/api/alerts/:id/ack` | | `{ok}` |
| GET | `/api/audit?limit=&site_id=` | | `AuditEntry[]` |
| GET / PUT | `/api/settings` | `AppSettings` | `AppSettings` |

## Screens Launcher v2: home screens (docs/LAUNCHER-V2.md)

Types are in `central/src/shared/launcher.ts`. A layout is the config v2 `home` object plus a name and an optional accent. It belongs to a site, or is a fleet template (`site_id: null`) that any site can use or copy. A box shows its own override if it has one, otherwise the site's layout. Without a layout it shows the classic v1 grid.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/launcher/layouts?site_id=` | | `LauncherLayout[]`: that site's layouts plus the fleet templates. `?templates=1` returns templates only, and no parameter returns all. Each layout has `used_by: {sites, devices}`. |
| GET | `/api/launcher/layouts/:id` | | `LauncherLayout` |
| POST | `/api/launcher/layouts` | `{site_id \| null, name, home?, accent?, from_id?, make_default?}` | `LauncherLayout` (201). `from_id` copies another layout's `home`/`accent`. `make_default` makes it the site's layout and pushes it. |
| PUT | `/api/launcher/layouts/:id` | `{name?, home?, accent?}` | `LauncherLayout`. When `home` or `accent` changes, it's pushed in the background to every box using it. |
| DELETE | `/api/launcher/layouts/:id` | | `{ok}`. Sites and boxes that used it fall back (site layout, else the classic grid) and are re-pushed. |
| POST | `/api/launcher/layouts/:id/copy` | `{site_id \| null, name?, make_default?}` | `LauncherLayout` (201): an independent copy for another site, or a new fleet template (`site_id: null`) |
| POST | `/api/launcher/assets` | multipart `file` | `LauncherAsset & {url}` (201). JPEG, PNG or WebP only (checked by magic bytes), at most 8 MB and 4096 px per side. Stored in R2 at `launcher/assets/<sha256>.<ext>`, idempotent. The dashboard resizes wallpapers to 1920 × 1080 JPEG (q≈0.85) and card art to ≤ 1280 px first. |
| GET | `/api/launcher/assets/:sha256.:ext` | | the image (for the dashboard preview) |
| GET | `/api/sites/:id/launcher` | | `LauncherSiteState`: `{layout_id, layouts, devices: LauncherDeviceRollout[], latest_version}`. Per Android box it gives `override_layout_id`, effective `layout_id`, `launcher` (facts), `supports_v2`, `expected_v`, `expected_sha` and `in_sync` (`facts.launcher.config_sha === expected_sha`). |
| PUT | `/api/sites/:id/launcher` | `{layout_id \| null}` | `{ok, layout_id}`: the site's layout (a layout of this site or a fleet template). Pushes to boxes without an override. |
| POST | `/api/sites/:id/launcher/push` | `{device_ids?}` | `{results: {device_id, ok, detail?}[]}`: push now (waits). Only online boxes with the launcher installed. |
| PUT | `/api/devices/:id/launcher` | `{layout_id \| null}` | `{ok, layout_id}`: "use a different layout on this box" (`null` = follow the site). Pushes to that box. |

Layout validation follows the contract exactly: 1–12 rows, row ids `[a-z0-9_-]{1,32}` and unique, titles and labels ≤ 40 characters, the icon/card/size/label enums, 0–40 package names per row matching `^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$`, `dim` 0–0.8, `focus.scale` 1.0–1.25. The resulting config must be ≤ 48 KB including the site's welcome and kiosk settings, and every referenced picture must be uploaded (≤ 64 MB in total). Errors are `400 bad_layout` with a plain-English message.

`Device.facts.launcher` (`LauncherState`) holds the app's STATUS (`version`, `version_code`, `config_sha`, `config_v`, `is_home`, `assets`, `missing_assets`, `last_error`) plus what Screens last sent: `pushed_at`, `pushed_sha`, `pushed_v`, `push_error`, `layout_id` and `assets_pushed`.

## Device commands (`POST /api/devices/:id/command`)

Which commands are available depends on `Device.capabilities`.

| command | args | kinds |
|---|---|---|
| `refresh` | – | all (re-read info/status) |
| `pair` | – | android (adb connect → "Allow debugging" prompt), samsung/lg (TV shows Allow prompt) |
| `key` | `{key}` with key ∈ `UP DOWN LEFT RIGHT OK BACK HOME MENU PLAY_PAUSE PLAY PAUSE STOP NEXT PREV REWIND FF VOL_UP VOL_DOWN MUTE POWER CH_UP CH_DOWN SETTINGS SEARCH INFO INPUT GUIDE 0-9` | android, samsung, lg |
| `text` | `{text}` | android, samsung, lg |
| `tap` | `{x, y}` (0–1 fractions of the screen) | android |
| `power_on` / `power_off` | – | all TVs/boxes |
| `reboot` | – | android |
| `volume` | `{level}` 0–100 or `{delta}` | all |
| `mute` | `{mute: bool}` | all |
| `apps` | – | android, samsung, lg → `DeviceApp[]` |
| `launch` | `{package}` (Android) or `{app_id}` (Samsung/LG) | |
| `stop` / `clear` | `{package}` | android |
| `disable` / `enable` | `{package}` | android |
| `uninstall` | `{package, keep_data?}` | android |
| `install` | `{apk_id}` | android |
| `play_store` | `{package}` | android (opens the Play Store page) |
| `screenshot` | – | android → `{url}` |
| `shell` | `{cmd}` | android → `{stdout, exit_code}` |
| `private_dns` | `{enabled: bool}` | android (checked, and reverted automatically if it fails) |
| `adb_pair` | `{code, port}` | android 11+ Wireless debugging: pairing code + pairing port shown on the TV |
| `revoke_permission` / `grant_permission` | `{package, permission: microphone\|camera\|location\|contacts}` | android |
| `debloat` | `{packages?}` (defaults to catalogue bloat) | android: disables, never uninstalls |
| `input` | `{source: TV\|HDMI1–4\|SOURCE}` | samsung |
| `media` | `{action: play\|pause\|stop\|next\|prev\|toggle, uuid?}` | sonos, android. Sonos: goes to the group coordinator; `play` checks the speaker really started and, if the last source can't resume (ended app session, expired stream, UPnP 701), re-selects the queue / reloads the source / falls back to the Sonos queue → `{state, detail?, now_playing, position}`; otherwise fails with a plain-English reason. `pause` on something already paused is OK; live streams are stopped. |
| `status` | – | sonos → live `{now_playing, position, group (with member + group volume), zones, play_mode, crossfade, sleep_timer, transport {kind, can_seek, can_skip, can_shuffle}}`, also merged into `facts`. The dashboard polls it every 20 s while a speaker is open. |
| `seek` | `{position_s}` or `{track}` (1-based queue position) | sonos |
| `play_mode` | `{shuffle?: bool, repeat?: off\|all\|one}` | sonos (queue only; radio/TV/app sessions refuse) |
| `crossfade` | `{on: bool}` | sonos |
| `queue` | `{start?, count? ≤ 100}` | sonos → `SonosQueue {items, total, start, current, active}` |
| `play_queue` / `remove_from_queue` | `{index}` (1-based) | sonos |
| `clear_queue` | – | sonos |
| `favorites` / `playlists` | – | sonos → `SonosBrowseItem[]` (Sonos favourites `FV:2` / Sonos playlists `SQ:`) |
| `play_favorite` | `{uri, meta}` from `favorites` or `playlists` | sonos: playlists, albums and single tracks replace the queue and play from track 1; radio/streams play directly |
| `inputs` / `play_input` | – / `{kind: line_in\|tv, uuid?}` | sonos: line-in on any adopted speaker that has one (`x-rincon-stream`), TV on soundbars/Amp (`x-sonos-htastream`) |
| `volume` / `mute` | also accept `uuid` to act on another room of the household | sonos |
| `group_volume` | `{level}` or `{delta}` | sonos (GroupRenderingControl on the coordinator, snapshot first) |
| `group_mute` | `{mute: bool}` | sonos |
| `group` / `join` | `{coordinator_id}` or `{coordinator_uuid}`, optional `uuid` = the room to move (default this speaker) | sonos |
| `ungroup` | `{uuid?}` | sonos: this speaker (or room `uuid`) plays on its own |
| `party` | – | sonos: every room joins this speaker's group |
| `pause_all` | – | sonos: pauses every playing group in the household → `{paused}` |
| `eq` | `{bass?, treble?, loudness?, night_mode?, speech?, sub_enabled?, sub_gain?, surround_enabled?, surround_level?, music_surround_level?, height_level?, audio_delay?}` | sonos (night/speech/levels: soundbars, Amp, rooms with a Sub; unsupported values come back as `"not supported"`) → `{eq, ht?}` |
| `settings` | – | sonos → `SonosSettings` (LED, button lock, EQ, home-theatre levels, crossfade, sleep timer remaining) |
| `button_lock` | `{on: bool}` | sonos (locks the speaker's touch controls) |
| `alarms` / `alarm_enable` | – / `{id, enabled}` | sonos: list Sonos alarms; turn one on/off (all other alarm fields are sent back unchanged) |
| `sleep_timer` | `{minutes}` (0 clears) | sonos |
| `led` | `{on: bool}` | sonos |
| `toast` | `{message}` | lg, android |
| `guest_reset` | – | android (samsung: best-effort Home). Re-opens the launcher welcome screen when enabled. |
| `launcher_install` | – | android: installs (or updates to) the newest Screens Launcher in the library, pushes its config (see `launcher_config`) and makes it the home screen |
| `launcher_config` | – | android: push the box's config. 2.x boxes with a layout get config v2, after any missing pictures are copied over. 1.x boxes, and boxes without a layout, get the v1 kiosk/welcome config. → `{ok, detail?, config: {config_v, sha, expected_sha, assets_pushed, assets_failed}, status}` |
| `launcher_status` | – | android → `{status: LauncherState}` (also stored in `facts.launcher`) |
| `launcher_remove` | – | android: restore the stock launcher and uninstall |
| `launcher_home` | – | android: make the installed Screens Launcher the home screen (`set-home-activity`, plus disabling the stock launcher when kiosk `force_home` is on) → `{status}` |
| `welcome_show` | – | android: show the welcome screen now |

Failed commands are stored on the device as `facts.last_error = {command, message, code, at}` (cleared when the same command next succeeds), so problems with quiet commands such as `media` and `volume` — which are not written to the audit log — stay visible. Background reads (`refresh`, `status`) don't overwrite it.

Sonos errors are translated from UPnP codes into plain English (`central/src/worker/adapters/sonos-parse.ts` → `sonosErrorMessage`), e.g. 701 on Play = the app/session that started the music has ended, 712 = shuffle/repeat need the Sonos queue, 716 = the music service couldn't find the item, 800 = only the group's main speaker can do that.

Site guest settings (`SiteSettings.guest`) include `welcome: WelcomeConfig`, `kiosk: KioskConfig` (write `kiosk.pin` as 4–8 digits, read `kiosk.pin_set`) and `show_welcome_after_reset`. Saving them re-pushes the launcher config to every device that has it.
