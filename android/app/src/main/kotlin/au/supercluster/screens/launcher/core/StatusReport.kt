package au.supercluster.screens.launcher.core

/** Body of the STATUS broadcast reply: `status:{"version":…,"config_sha":…,"is_home":…}`. */
data class StatusReport(
    val version: String,
    /** SHA-256 hex of the stored config JSON, or null when none is stored. */
    val configSha: String?,
    val isHome: Boolean,
) {
    fun toJson(): String = Json.write(
        linkedMapOf(
            "version" to version,
            "config_sha" to configSha,
            "is_home" to isHome,
        ),
    )

    fun toResultData(): String = "status:" + toJson()
}
