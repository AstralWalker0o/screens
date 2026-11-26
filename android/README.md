# Screens Launcher (Android TV)

The kiosk launcher and guest welcome screen that Screens installs on Android TV boxes
(`au.supercluster.screens.launcher`). The contract it implements (components, config JSON,
broadcast protocol and kiosk rules) is in [`../docs/LAUNCHER.md`](../docs/LAUNCHER.md).

**Privacy:** the app has no `INTERNET` permission, no analytics and no network code. Everything
arrives over adb from the Screens gateway. On top of that:

- androidx's `EmojiCompatInitializer` is removed from the manifest, because it would otherwise ask
  the Play Services font provider for a downloadable emoji font;
- backups and device-to-device transfer are disabled, since the config holds the guest Wi-Fi
  password and the kiosk PIN hash;
- the config receiver never logs the config itself.

Check with `aapt2 dump permissions dist/screens-launcher.apk`. The only permissions are
`RECEIVE_BOOT_COMPLETED` and androidx's signature-level `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`.

## Build

You need:

- JDK 17 or newer (built and tested with OpenJDK 21; bytecode targets 17)
- the Android SDK with `platforms;android-36` and `build-tools;36.0.0`, installed **outside** the
  repo, for example:

  ```sh
  # one-off SDK setup (Linux)
  mkdir -p /opt/android-sdk/cmdline-tools && cd /opt/android-sdk/cmdline-tools
  curl -O https://dl.google.com/android/repository/commandlinetools-linux-<rev>_latest.zip
  unzip commandlinetools-linux-*_latest.zip && mv cmdline-tools latest
  yes | latest/bin/sdkmanager --sdk_root=/opt/android-sdk --licenses
  latest/bin/sdkmanager --sdk_root=/opt/android-sdk "platforms;android-36" "build-tools;36.0.0"
  ```

Point the build at the SDK with `ANDROID_HOME=/opt/android-sdk`, or with a git-ignored
`local.properties` containing `sdk.dir=/opt/android-sdk`.

```sh
cd android
./gradlew test               # JVM unit tests (config parsing, app ordering, Wi-Fi QR, PIN)
./gradlew assembleRelease    # app/build/outputs/apk/release/app-release.apk
mkdir -p dist && cp app/build/outputs/apk/release/app-release.apk dist/screens-launcher.apk
```

`dist/`, `build/`, `.gradle/`, `local.properties` and every `*.keystore` / `*.jks` are git-ignored.

### Release signing

The release build reads its keystore from the environment:

| Variable | Meaning |
|---|---|
| `SCREENS_KEYSTORE` | Path to the keystore (`.jks` / `.keystore`), kept outside the repo |
| `SCREENS_KEYSTORE_PASSWORD` | Keystore password |
| `SCREENS_KEY_ALIAS` | Key alias |
| `SCREENS_KEY_PASSWORD` | Key password |

If `SCREENS_KEYSTORE` isn't set, the release APK is signed with the local **debug** keystore
(`~/.android/debug.keystore`, created by the Android Gradle plugin on first use) and Gradle prints
a warning. That APK installs and runs, but it can't be upgraded in place by one signed with the
real key, and the other way round. **Never commit a keystore.**

To create a key once (store it in a password manager or CI secret, not in git):

```sh
keytool -genkeypair -v -keystore ~/secure/screens-release.jks -alias screens \
  -keyalg RSA -keysize 4096 -validity 10000
SCREENS_KEYSTORE=~/secure/screens-release.jks SCREENS_KEYSTORE_PASSWORD=… \
SCREENS_KEY_ALIAS=screens SCREENS_KEY_PASSWORD=… ./gradlew assembleRelease
```

## Using it over adb

```sh
adb install -r dist/screens-launcher.apk
adb shell cmd package set-home-activity au.supercluster.screens.launcher/.LauncherActivity
# A freshly installed app is in Android's "stopped" state and gets no broadcasts until it has
# been launched once, so start it (or press Home) before the first CONFIG/STATUS broadcast,
# or add --include-stopped-packages to `am broadcast`.
adb shell am start -n au.supercluster.screens.launcher/.LauncherActivity

# config (see docs/LAUNCHER.md for the JSON)
adb shell am broadcast -a au.supercluster.screens.launcher.CONFIG \
  -n au.supercluster.screens.launcher/.ConfigReceiver \
  --es config_b64 "$(base64 -w0 config.json)"
# → Broadcast completed: result=1, data="ok:<sha256 of config.json>"

adb shell am broadcast -a au.supercluster.screens.launcher.STATUS \
  -n au.supercluster.screens.launcher/.ConfigReceiver
# → result=1, data="status:{"version":"1.0.0","config_sha":"…","is_home":true}"

adb shell am start -n au.supercluster.screens.launcher/.WelcomeActivity
```

`ConfigReceiver` is protected by `android.permission.DUMP`, so only the adb shell or the system
can deliver config.

## Behaviour

- **Launcher.** HOME + LEANBACK_LAUNCHER, `singleTask`. It has a dark 10-foot UI with the site name
  on the left, the clock and date on the right, and the accent colour from the config. App cards
  show the app's TV banner, or its icon if it has none, and you move between them with the D-pad.
  Back does nothing. Pressing Home while already home returns focus to the first card. The app
  list refreshes when packages are installed, removed or changed, and on every resume.
- **Kiosk on.** Only installed apps listed in `kiosk.allowed` are shown: `pinned` first, then the
  rest by name. There is no Settings tile. The clock can take focus (press up from the top row),
  and a long-press on OK asks for the PIN on a D-pad keypad (remote number keys work too). The
  PIN is checked against `pin_sha256` (SHA-256 of the PIN's UTF-8 digits) before
  `Settings.ACTION_SETTINGS` opens. With `pin_sha256: null` the long-press opens settings
  directly. Five wrong PINs lock entry for 30 seconds.
- **Kiosk off.** All apps with a LEANBACK_LAUNCHER (or LAUNCHER) activity are shown, pinned first,
  plus a Settings tile.
- **Welcome.** It shows the title, message, a Wi-Fi card (SSID, password, and a
  `WIFI:T:<sec>;S:<ssid>;P:<password>;;` QR code with `\ ; , : "` escaped), up to 6 info cards,
  the contact line and one focused **Start watching** button. That button, or Back, returns to the
  launcher.
- **Welcome pending.** `BootReceiver` sets it on `BOOT_COMPLETED` when `welcome.enabled` and
  `welcome.show_on_boot` are both set. A CONFIG broadcast sets it when the JSON contains
  `"show_welcome": true`, or when the intent has `--ez show_welcome true`. The launcher watches
  the flag, so it opens the welcome screen as soon as the launcher is in front, even if the
  broadcast arrives while it is already showing. The flag is cleared once the welcome screen
  appears.

### Config validation

Configs are checked strictly. One bad value rejects the whole config with
`result=0, data="error:<field>: <problem>"`, and the previous config stays in place.

| Rule | Detail |
|---|---|
| Size | Decoded JSON ≤ 64 KB, strict UTF-8, one top-level object, nesting ≤ 32 |
| Version | `v` must be `1` |
| Unknown fields | Ignored; `null` means "not set" for optional fields |
| Package names | `kiosk.allowed` and `pinned` entries must match `^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$` (≤ 255 chars); at most 500 per list; duplicates dropped |
| `kiosk.pin_sha256` | 64 hex characters (any case) or `null` |
| `accent` | `#RRGGBB` or `#AARRGGBB` |
| `wifi` | `ssid` ≤ 32 UTF-8 bytes; `password` ≤ 64 chars; no control characters; `security` is `WPA` (also accepts `WPA2`), `WEP` or `nopass`, case-insensitive. Without `security`, it is `WPA` if there is a password, else `nopass`. A blank SSID with no password means no Wi-Fi card |
| Display text | Control characters are stripped, then the text is truncated with "…": site name 64, title 120, message 1000, section title 80, section body 600, contact 200 (code points). At most 6 sections |

With no config stored, or an unreadable one: kiosk is off and the welcome screen is off. Once a
config has arrived, `welcome.enabled` and `welcome.show_on_boot` default to `true`. The JSON is
stored verbatim in the app-private `filesDir/config.json`, written atomically, so `config_sha`
always equals the SHA-256 of what the gateway sent.

## Layout

```
android/
├── build.gradle.kts, settings.gradle.kts, gradle.properties
├── gradle/libs.versions.toml           # version catalog
├── gradle/wrapper/, gradlew            # Gradle 8.14.8 wrapper (checksum-pinned)
└── app/
    ├── build.gradle.kts                # signing from SCREENS_* env vars, R8 on release
    └── src/
        ├── main/AndroidManifest.xml
        ├── main/kotlin/au/supercluster/screens/launcher/
        │   ├── LauncherActivity.kt, WelcomeActivity.kt
        │   ├── ConfigReceiver.kt, BootReceiver.kt
        │   ├── core/                   # plain Kotlin, unit-tested on the JVM
        │   │   ├── Json.kt             # strict JSON reader/writer with depth cap
        │   │   ├── ConfigParser.kt     # base64 → JSON → validated LauncherConfig
        │   │   ├── LauncherConfig.kt, AppSelector.kt, WifiQr.kt, Pin.kt, Hashing.kt, StatusReport.kt
        │   ├── data/                   # Android glue: ConfigStore, AppRepository, HomeStatus
        │   └── ui/                     # Compose for TV: LauncherScreen, PinDialog, WelcomeScreen, QrCode, Theme
        ├── main/res/                   # vector icon (adaptive) and banner, strings, theme
        └── test/kotlin/…/core/         # JUnit tests
```

Dependencies: AndroidX (core-ktx, activity-compose, lifecycle-runtime-compose, Compose UI and
foundation, `androidx.tv:tv-material`) plus `com.google.zxing:core` for the QR code. JUnit is used
for tests only.
