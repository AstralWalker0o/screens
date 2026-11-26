package au.supercluster.screens.launcher.core

/**
 * Body of the STATUS broadcast reply (docs/LAUNCHER-V2.md §1.3):
 * `status:{"version":…,"version_code":…,"config_sha":…,"config_v":…,"is_home":…,"assets":[…],"missing_assets":[…],"last_error":…}`.
 * It keeps every v1 field (`version`, `config_sha`, `is_home`), so v1 parsers keep working.
 * Keys are written in the contract's order.
 */
data class StatusReport(
    val version: String,
    /** SHA-256 hex of the stored config JSON, or null when none is stored. */
    val configSha: String?,
    val isHome: Boolean,
    val versionCode: Long = 0,
    /** `v` of the stored config, or null when none is stored. */
    val configVersion: Int? = null,
    /** SHA-256 of every stored asset. */
    val assets: List<String> = emptyList(),
    /** SHA-256 of every asset the stored config references that isn't stored. */
    val missingAssets: List<String> = emptyList(),
    val lastError: String? = null,
) {
    fun toJson(): String = Json.write(
        linkedMapOf(
            "version" to version,
            "version_code" to versionCode,
            "config_sha" to configSha,
            "config_v" to configVersion,
            "is_home" to isHome,
            "assets" to assets.sorted(),
            "missing_assets" to missingAssets.sorted(),
            "last_error" to lastError,
        ),
    )

    fun toResultData(): String = "status:" + toJson()

    companion object {
        /** Keeps `last_error` short enough for one `am broadcast` result line. */
        const val MAX_LAST_ERROR = 300
    }
}
