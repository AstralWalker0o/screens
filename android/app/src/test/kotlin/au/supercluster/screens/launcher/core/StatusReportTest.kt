package au.supercluster.screens.launcher.core

import org.junit.Assert.assertEquals
import org.junit.Test

class StatusReportTest {
    @Test
    fun formatsTheDocumentedStatusLine() {
        // docs/LAUNCHER-V2.md §1.3: every v1 field plus version_code, config_v, assets,
        // missing_assets and last_error, in the contract's order.
        assertEquals(
            "status:{\"version\":\"2.0.0\",\"version_code\":20000,\"config_sha\":\"abc\",\"config_v\":2,\"is_home\":true," +
                "\"assets\":[\"aa\",\"bb\"],\"missing_assets\":[\"cc\"],\"last_error\":\"asset cc: sha256 mismatch\"}",
            StatusReport(
                version = "2.0.0",
                configSha = "abc",
                isHome = true,
                versionCode = 20000,
                configVersion = 2,
                assets = listOf("bb", "aa"),
                missingAssets = listOf("cc"),
                lastError = "asset cc: sha256 mismatch",
            ).toResultData(),
        )
        assertEquals(
            "{\"version\":\"2.0.0\",\"version_code\":20000,\"config_sha\":null,\"config_v\":null,\"is_home\":false," +
                "\"assets\":[],\"missing_assets\":[],\"last_error\":null}",
            StatusReport("2.0.0", null, false, versionCode = 20000).toJson(),
        )
    }

    @Test
    fun statusJsonParsesBackWithTheV1Fields() {
        val parsed = Json.parse(StatusReport("2.0.0", "abc", true, 20000, 1).toJson()) as Map<*, *>
        assertEquals("2.0.0", parsed["version"])
        assertEquals("abc", parsed["config_sha"])
        assertEquals(true, parsed["is_home"])
        assertEquals(20000L, parsed["version_code"])
        assertEquals(1L, parsed["config_v"])
    }

    @Test
    fun hexHelpers() {
        val bytes = byteArrayOf(0, 1, 0x7f, -1)
        assertEquals("00017fff", Hashing.toHex(bytes))
        assertEquals(bytes.toList(), Hashing.fromHex("00017FFF")!!.toList())
        assertEquals(null, Hashing.fromHex("abc"))
        assertEquals(null, Hashing.fromHex("zz"))
    }
}
