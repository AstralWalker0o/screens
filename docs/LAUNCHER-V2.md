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
