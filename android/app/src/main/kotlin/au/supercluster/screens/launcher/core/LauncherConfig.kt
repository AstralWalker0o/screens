package au.supercluster.screens.launcher.core

/**
 * Validated, immutable launcher configuration: config JSON v1 (docs/LAUNCHER.md) or v2
 * (docs/LAUNCHER-V2.md). A v2 config without `home` behaves exactly like v1.
 */
data class LauncherConfig(
    /** The config's `v` (1 or 2). */
    val version: Int = 1,
    val siteName: String = "",
    /** ARGB colour. */
    val accentArgb: Int = DEFAULT_ACCENT,
    val kiosk: Kiosk = Kiosk(),
    val pinned: List<String> = emptyList(),
    val welcome: Welcome = Welcome(),
    /** v2 home screen layout, or null for the v1 grid. */
    val home: Home? = null,
    /** One-shot request carried by a CONFIG broadcast: show the welcome screen now. */
    val showWelcome: Boolean = false,
) {
    data class Kiosk(
        val enabled: Boolean = false,
        val allowed: List<String> = emptyList(),
        /** Lower-case hex SHA-256 of the PIN, or null for no PIN. */
        val pinSha256: String? = null,
    )

    data class Welcome(
        val enabled: Boolean = false,
        val showOnBoot: Boolean = false,
        /** Empty means "use the default title" (Welcome / Welcome to <site>). */
        val title: String = "",
        val message: String = "",
        val wifi: Wifi? = null,
        val sections: List<Section> = emptyList(),
        val contact: String = "",
    )

    data class Wifi(
        val ssid: String,
        val password: String,
        val security: WifiSecurity,
    )

    data class Section(val title: String, val body: String)

    /** `home` (v2): wallpaper, top bar and rows of app cards. */
    data class Home(
        /** Null means the built-in dark gradient. */
        val wallpaper: Wallpaper? = null,
        val topBar: TopBar = TopBar(),
        val rows: List<Row> = emptyList(),
        val allApps: AllApps = AllApps(),
        /** Packages never shown anywhere. */
        val hidden: List<String> = emptyList(),
        /** Per-package overrides, keyed by package name. */
        val tiles: Map<String, Tile> = emptyMap(),
        val focus: Focus = Focus(),
    ) {
        /** Every asset SHA the home screen references (wallpaper and tile art). */
        fun referencedAssets(): Set<String> {
            val out = LinkedHashSet<String>()
            wallpaper?.let { out.add(it.asset.sha256) }
            tiles.values.forEach { tile -> tile.asset?.let { out.add(it.sha256) } }
            return out
        }
    }

    data class Wallpaper(
        val asset: AssetRef,
        /** 0–0.8: opacity of the black overlay drawn over the image. */
        val dim: Float = DEFAULT_DIM,
    )

    data class TopBar(
        val clock: Boolean = true,
        /** null = follow the device's 12/24-hour setting. */
        val clock24h: Boolean? = null,
        val date: Boolean = false,
        val network: Boolean = true,
        val settings: Boolean = true,
    )

    data class Row(
        val id: String,
        val title: String = "",
        val icon: RowIcon = RowIcon.NONE,
        val card: CardStyle = CardStyle.BANNER,
        val size: CardSize = CardSize.MEDIUM,
        val apps: List<String> = emptyList(),
    )

    data class AllApps(
        val enabled: Boolean = true,
        /** Empty means the default "All apps" title. */
        val title: String = "",
    )

    data class Tile(
        /** Empty means "use the app's own label". */
        val label: String = "",
        val asset: AssetRef? = null,
    )

    data class Focus(
        val scale: Float = DEFAULT_FOCUS_SCALE,
        val label: LabelMode = LabelMode.FOCUSED,
    )

    /** Every asset SHA this config references (empty for v1 / no home). */
    fun referencedAssets(): Set<String> = home?.referencedAssets() ?: emptySet()

    companion object {
        const val DEFAULT_ACCENT: Int = 0xFF4F8EF7.toInt()
        const val DEFAULT_DIM = 0.25f
        const val DEFAULT_FOCUS_SCALE = 1.12f

        /** Used when no config has arrived yet or the stored one is unreadable: kiosk off, welcome off. */
        val DEFAULT = LauncherConfig()
    }
}

/** A content-addressed image pushed through the assets provider. */
data class AssetRef(
    /** Lower-case hex SHA-256 of the file's bytes. */
    val sha256: String,
    val ext: AssetExt,
)

enum class AssetExt(val token: String, val mimeType: String) {
    JPG("jpg", "image/jpeg"),
    PNG("png", "image/png"),
    WEBP("webp", "image/webp"),
    ;

    companion object {
        fun fromToken(token: String): AssetExt? = entries.firstOrNull { it.token == token }
    }
}

enum class WifiSecurity(val qrToken: String) {
    WPA("WPA"),
    WEP("WEP"),
    NOPASS("nopass"),
}

/** Row header glyphs (`home.rows[].icon`). */
enum class RowIcon(val token: String) {
    BOOKMARK("bookmark"),
    MEDIA("media"),
    STAR("star"),
    TV("tv"),
    MUSIC("music"),
    GAMES("games"),
    KIDS("kids"),
    SETTINGS("settings"),
    APPS("apps"),
    NONE("none"),
    ;

    companion object {
        fun fromToken(token: String): RowIcon? = entries.firstOrNull { it.token == token }
    }
}

/** `home.rows[].card`: 16:9 app banner, square icon on a tinted card, or 2:3 poster. */
enum class CardStyle(val token: String) {
    BANNER("banner"),
    ICON("icon"),
    POSTER("poster"),
    ;

    companion object {
        fun fromToken(token: String): CardStyle? = entries.firstOrNull { it.token == token }
    }
}

enum class CardSize(val token: String) {
    SMALL("small"),
    MEDIUM("medium"),
    LARGE("large"),
    ;

    companion object {
        fun fromToken(token: String): CardSize? = entries.firstOrNull { it.token == token }
    }
}

/** `home.focus.label`: when the app name shows under a card. */
enum class LabelMode(val token: String) {
    ALWAYS("always"),
    FOCUSED("focused"),
    NEVER("never"),
    ;

    companion object {
        fun fromToken(token: String): LabelMode? = entries.firstOrNull { it.token == token }
    }
}
