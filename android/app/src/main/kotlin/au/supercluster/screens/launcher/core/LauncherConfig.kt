package au.supercluster.screens.launcher.core

/** Validated, immutable launcher configuration (config JSON v1, see docs/LAUNCHER.md). */
data class LauncherConfig(
    val siteName: String = "",
    /** ARGB colour. */
    val accentArgb: Int = DEFAULT_ACCENT,
    val kiosk: Kiosk = Kiosk(),
    val pinned: List<String> = emptyList(),
    val welcome: Welcome = Welcome(),
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

    companion object {
        const val DEFAULT_ACCENT: Int = 0xFF4F8EF7.toInt()

        /** Used when no config has arrived yet or the stored one is unreadable: kiosk off, welcome off. */
        val DEFAULT = LauncherConfig()
    }
}

enum class WifiSecurity(val qrToken: String) {
    WPA("WPA"),
    WEP("WEP"),
    NOPASS("nopass"),
}
