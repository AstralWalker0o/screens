package au.supercluster.screens.launcher.core

import org.junit.Assert.assertEquals
import org.junit.Test

class StatusReportTest {
    @Test
    fun formatsTheDocumentedStatusLine() {
        assertEquals(
            "status:{\"version\":\"1.0.0\",\"config_sha\":\"abc\",\"is_home\":true}",
            StatusReport("1.0.0", "abc", true).toResultData(),
        )
        assertEquals("{\"version\":\"1.0.0\",\"config_sha\":null,\"is_home\":false}", StatusReport("1.0.0", null, false).toJson())
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
