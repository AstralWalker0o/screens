# Screens Launcher (Android TV): kiosk and welcome screen

An Android TV app (`au.supercluster.screens.launcher`) that Screens installs
and configures over adb. It provides:

- **Launcher / kiosk**: an Android TV home screen that shows only the apps you
  allow, in your order, with the property name and a clock. Settings are behind
  a PIN.
- **Welcome screen**: a full-screen greeting with the Wi-Fi name and password,
  a Wi-Fi QR code to join, house info sections and a contact line. It shows on
  boot and after every guest reset.

The app has **no network permission**. Everything arrives over adb from the
Screens gateway. It never phones home.

> **Launcher v2 (app 2.0.0, versionCode 20000)** adds a full home screen with a
> wallpaper, a top bar and rows of app cards, configured with config `"v": 2`.
> It also adds image assets pushed with `content write` and extra STATUS
> fields. See [LAUNCHER-V2.md](LAUNCHER-V2.md). Everything in this file still
> applies: 2.0.0 accepts the v1 configs below unchanged and shows them with the
> v1 grid. The STATUS reply gains fields but keeps every v1 field.

## Package and components

| Component | Name | Notes |
|---|---|---|
| Package | `au.supercluster.screens.launcher` | |
| Launcher activity | `.LauncherActivity` | `MAIN` + `HOME` + `DEFAULT` + `LEANBACK_LAUNCHER`. `launchMode=singleTask`. |
| Welcome activity | `.WelcomeActivity` | Exported (so `am start` works), no intent filters. |
| Config receiver | `.ConfigReceiver` | Exported, **protected by `android:permission="android.permission.DUMP"`**, so only the adb shell / system can send it config. Normal apps can't hold DUMP. |
| Boot receiver | `.BootReceiver` | `BOOT_COMPLETED` → set "welcome pending" if `welcome.show_on_boot`. |
| Assets provider (v2) | `.AssetProvider` | Authority `au.supercluster.screens.launcher.assets`, exported, read/write permission `android.permission.DUMP`. See [LAUNCHER-V2.md](LAUNCHER-V2.md) §1.1. |

## Config delivery

```sh
am broadcast -a au.supercluster.screens.launcher.CONFIG \
  -n au.supercluster.screens.launcher/.ConfigReceiver \
  --es config_b64 '<base64 of UTF-8 JSON>'
```

The receiver validates and stores the config, then calls
`setResultCode(1)` / `setResultData("ok:<sha256-hex of the JSON>")`. On error
it sets `setResultCode(0)` / `setResultData("error:<message>")`. `am`
prints `Broadcast completed: result=1, data="ok:…"`, which Screens parses.

Status query (no config change):

```sh
am broadcast -a au.supercluster.screens.launcher.STATUS -n au.supercluster.screens.launcher/.ConfigReceiver
# → result=1, data="status:{"version":"1.0.0","config_sha":"…","is_home":true}"
```

`am` prints `data` verbatim: the JSON's quotes are **not** escaped, so read up
to the last `"` on the line. App 2.0.0 adds `version_code`, `config_v`,
`assets`, `missing_assets` and `last_error`; see
[LAUNCHER-V2.md](LAUNCHER-V2.md) §1.3.

Show the welcome screen now (e.g. after guest reset):

```sh
am start -n au.supercluster.screens.launcher/.WelcomeActivity
```

## Config JSON (v1)

(For v2, with `home`, see [LAUNCHER-V2.md](LAUNCHER-V2.md) §2.)

```json
{
  "v": 1,
  "site_name": "Beach House",
  "accent": "#4F8EF7",
  "kiosk": {
    "enabled": true,
    "allowed": ["com.netflix.ninja", "com.google.android.youtube.tv", "au.com.stan.and"],
    "pin_sha256": "<hex sha256 of the PIN, or null for no PIN>"
  },
  "pinned": ["com.netflix.ninja", "com.google.android.youtube.tv"],
  "welcome": {
    "enabled": true,
    "show_on_boot": true,
    "title": "Welcome to Beach House",
    "message": "We hope you enjoy your stay.",
    "wifi": { "ssid": "BeachHouse-Guest", "password": "sunny-days", "security": "WPA" },
    "sections": [
      { "title": "Checkout", "body": "Please check out by 10 am." },
      { "title": "TV tips", "body": "Press Home to return here. Your logins are cleared after you leave." }
    ],
    "contact": "Questions? Text Nik on 0400 000 000"
  }
}
```

Rules:

- With `kiosk.enabled`, the launcher shows only installed apps that are in
  `allowed`, ordered by `pinned` first and then by name. The Settings tile is
  hidden, and long-pressing the clock asks for the PIN to open Android
  settings.
- Without kiosk, the launcher shows all apps with `LEANBACK_LAUNCHER` (or
  `LAUNCHER`) activities, pinned first, plus a Settings tile.
- A missing or invalid config means a sensible default: kiosk off, and
  welcome off unless a config has arrived.
- `wifi.security` is `WPA`, `WEP` or `nopass`. The QR code payload is the
  standard `WIFI:T:<sec>;S:<ssid>;P:<password>;;`, with `\ ; , : "` escaped
  by a backslash.
- Back on the launcher does nothing. The welcome screen's single button ("Start
  watching") dismisses it to the launcher.

## Making it the home screen (done by Screens over adb)

```sh
cmd package set-home-activity au.supercluster.screens.launcher/.LauncherActivity
# Some Google TV builds also need the stock launcher disabled ("force" option):
pm disable-user --user 0 com.google.android.tvlauncher   # Android TV
pm disable-user --user 0 com.google.android.apps.tv.launcherx  # Google TV
```

Removal re-enables the stock launcher, sets it back as home, and uninstalls the
app.
