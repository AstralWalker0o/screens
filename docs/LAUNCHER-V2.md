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
```

- Provider authority: `au.supercluster.screens.launcher.assets`, exported, with
  `android:readPermission` and `android:writePermission` set to
  `android.permission.DUMP`. Only the adb shell can use it.
- Path segment: `<64 hex>.<jpg|png|webp>`. Anything else is rejected.
- The app writes to internal storage (`files/assets/`), verifies the SHA-256
  after the write and deletes the file on a mismatch.
- Assets not referenced by the current config are deleted 24 h after a new
  config is applied.
- Limits: 8 MB per asset, 64 MB total.
- Asset list query:
  `content query --uri content://au.supercluster.screens.launcher.assets/`
  prints one row per stored asset as `Row: N sha256=<hex>, bytes=<n>`.

### 1.2 Config

Config is unchanged from v1: an `am broadcast` to `.ConfigReceiver` with
`--es config_b64 <base64 JSON>`. The result is `ok:<sha256 of JSON>` or
`error:<message>`.

The config JSON must stay **under 48 KB** before base64. A config that
references a missing asset is still **accepted**: the app shows the fallback
(plain gradient background, or the app's own banner) and reports the missing
SHAs in STATUS.

### 1.3 STATUS (extended)

`data="status:{...}"` gains the following fields:

```json
{ "version": "2.0.0", "version_code": 20000, "config_sha": "…", "config_v": 2, "is_home": true,
  "assets": ["<sha>", "…"], "missing_assets": ["<sha>"], "last_error": null }
```

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

## 4. Cloud side (Screens central)

This section describes what the hub does. It adds nothing the app has to
implement.

### 4.1 Where layouts live

- D1 `launcher_layouts` (migration 0004) stores the `home` object plus a name
  and an optional `accent`. Each layout belongs to a site, or is a fleet
  template (`site_id` NULL).
- `sites.launcher_layout_id` is the site's layout. `devices.launcher_layout_id`
  overrides it for one box ("use a different layout on this box").
- Images are in `launcher_assets` (metadata) and R2 at
  `launcher/assets/<sha256>.<ext>`.
- Routes: docs/API.md, "Screens Launcher v2". The dashboard editor is the
  site's **Home screen** tab.

### 4.2 Which config a box gets

| Box | Has a layout | Sent |
|---|---|---|
| launcher 2.x (`version_code ≥ 20000` or major ≥ 2) | yes | config `v: 2` with `home`, after copying any missing images |
| launcher 2.x | no | config `v: 1`, unchanged (a 2.x app must accept it) |
| launcher 1.x | either | config `v: 1`, and no images (the 1.0 app rejects `"v": 2` and has no provider) |
| unknown (STATUS unreadable) | either | config `v: 1` |

The config JSON is built in one place (`central/src/shared/launcher.ts`) with
a fixed key order. The SHA-256 the hub expects is therefore reproducible, and
the v1 bytes are identical to what Screens sent before v2.

The top-level `accent` is the layout's accent when it has one, otherwise the
welcome accent. 1.x boxes always get the welcome accent.

### 4.3 Push pipeline (per box, `launcher_config` / `launcher_install`)

```sh
# 1. STATUS: am broadcast --include-stopped-packages -a au.supercluster.screens.launcher.STATUS -n au.supercluster.screens.launcher/.ConfigReceiver
#    The "assets" list says what the box has. If a 2.x STATUS lacks it, the hub falls back to:
content query --uri content://au.supercluster.screens.launcher.assets/ 2>&1
# 2. For each image the layout references that the box doesn't have (2.x only):
#    gateway op adb.push {serial, url: <signed R2 URL, 30 min>, sha256, remote_path: /data/local/tmp/screens-asset-<sha>.<ext>}
content write --uri content://au.supercluster.screens.launcher.assets/<sha>.<ext> < /data/local/tmp/screens-asset-<sha>.<ext> 2>&1; echo "@@rc=$?"; rm -f /data/local/tmp/screens-asset-<sha>.<ext>
#    A non-zero rc, or "exception" / "error" in the output, counts as a failed image.
# 3. am broadcast … .CONFIG --es config_b64 <base64>  →  ok:<sha>, which must equal the SHA-256 of the bytes sent.
# 4. STATUS again; the result is stored in Device.facts.launcher.
```

- A failed image doesn't block the config: the box shows its fallback and
  reports the SHA in `missing_assets`.
- Screens records `pushed_at`, `pushed_sha`, `pushed_v`, `push_error`,
  `layout_id` and `assets_pushed` next to the STATUS fields in
  `facts.launcher`.
- A box is "in sync" when its `config_sha` equals the SHA expected for its
  version.

### 4.4 When the hub pushes

- **Layout saved:** every box whose effective layout it is.
- **Site layout or box override changed:** those boxes.
- **Guest welcome or kiosk saved:** every box at the site (as in v1).
- **"Push now":** from the dashboard.
- **After the gateway reconnects, when a box comes back online, and every 30
  minutes:** the hub reads STATUS quietly and pushes only if `config_sha`
  differs from the expected SHA. It also pushes if `missing_assets` is
  non-empty and the last push was more than 30 minutes ago.

### 4.5 Cloud-side checks beyond the contract

The app doesn't need any of these. They keep bad input from ever reaching a
box.

- Uploads must be JPEG, PNG or WebP by magic bytes, ≤ 8 MB and **≤ 4096 px on
  the longest side** (the pixel limit is cloud-only).
- The dashboard resizes wallpapers to 1920 × 1080 JPEG (q≈0.85) and card art
  to ≤ 1280 px before uploading.
- A layout is rejected unless its v2 config, including each using site's
  welcome and kiosk settings, stays ≤ 48 KB.
- Every image the layout references must already be uploaded, ≤ 64 MB in
  total.
- Duplicate packages within one row, or in `hidden`, are dropped. Tile
  overrides with neither a label nor an image are dropped.
- `home.rows` must have at least one row, as in §2. The editor won't delete
  the last row.

### 4.6 Simulator

`tools/sim/sim.py` emulates the 2.x app by default: v2 STATUS, the asset
provider with SHA checks on `content write`, and v1 + v2 configs. An APK
containing the bytes `SCREENS_LAUNCHER_V1` installs as the 1.0.0 app instead.

The simulator also accepts `content delete --uri …/<sha>.<ext>` so the e2e test
can make a box lose an image. The contract doesn't require the real app to
support it.
