package au.supercluster.screens.launcher.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WifiQrTest {
    private val bs = "\\" // one backslash, to keep the expectations readable

    @Test
    fun escapesEverySpecialCharacter() {
        assertEquals("a${bs}${bs}b${bs};c${bs},d${bs}:e${bs}\"f", WifiQr.escape("a${bs}b;c,d:e\"f"))
        assertEquals("plain-ssid_123 ok", WifiQr.escape("plain-ssid_123 ok"))
        assertEquals(bs.repeat(4), WifiQr.escape(bs.repeat(2)))
        assertEquals("", WifiQr.escape(""))
    }

    @Test
    fun buildsTheDocumentedPayload() {
        val wifi = LauncherConfig.Wifi("BeachHouse-Guest", "sunny-days", WifiSecurity.WPA)
        assertEquals("WIFI:T:WPA;S:BeachHouse-Guest;P:sunny-days;;", WifiQr.payload(wifi))
    }

    @Test
    fun escapesSsidAndPassword() {
        assertEquals(
            "WIFI:T:WEP;S:My${bs};Net${bs}:5G;P:p${bs}\"w${bs},d${bs}${bs};;",
            WifiQr.payload("My;Net:5G", "p\"w,d$bs", WifiSecurity.WEP),
        )
    }

    @Test
    fun openNetworkHasEmptyPassword() {
        assertEquals("WIFI:T:nopass;S:Cafe;P:;;", WifiQr.payload("Cafe", "secret", WifiSecurity.NOPASS))
    }

    @Test
    fun encodesAsciiAndUnicodePayloads() {
        for (payload in listOf("WIFI:T:WPA;S:BeachHouse-Guest;P:sunny-days;;", "WIFI:T:WPA;S:Caf\u00e9 \uD83C\uDF0A;P:\u00e9t\u00e9;;")) {
            val m = WifiQr.matrix(payload)
            assertTrue(m.size >= 21)
            assertEquals(0, (m.size - 21) % 4) // QR sizes are 21 + 4k
            assertTrue(m.all { it.size == m.size })
            // Top-left finder pattern: dark 7x7 border.
            assertTrue((0 until 7).all { m[0][it] && m[6][it] && m[it][0] && m[it][6] })
        }
    }
}
