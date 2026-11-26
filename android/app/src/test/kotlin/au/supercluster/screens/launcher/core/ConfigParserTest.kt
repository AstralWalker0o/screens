package au.supercluster.screens.launcher.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.Base64

class ConfigParserTest {

    /** The example from docs/LAUNCHER.md, verbatim apart from the PIN hash. */
    private val docExample = """
        {
          "v": 1,
          "site_name": "Beach House",
          "accent": "#4F8EF7",
          "kiosk": {
            "enabled": true,
            "allowed": ["com.netflix.ninja", "com.google.android.youtube.tv", "au.com.stan.and"],
            "pin_sha256": "03AC674216F3E15C761EE1A5E255F067953623C8B388B4459E13F978D7C846F4"
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
    """.trimIndent()

    private fun ok(json: String): LauncherConfig = ConfigParser.parse(json)

    private fun error(json: String): String {
        return when (val r = ConfigParser.fromBytes(json.toByteArray())) {
            is ConfigResult.Error -> r.message
            is ConfigResult.Ok -> fail("expected an error for: $json") as Nothing
        }
    }

    @Test
    fun parsesTheDocumentedExample() {
        val c = ok(docExample)
        assertEquals("Beach House", c.siteName)
        assertEquals(0xFF4F8EF7.toInt(), c.accentArgb)
        assertTrue(c.kiosk.enabled)
        assertEquals(listOf("com.netflix.ninja", "com.google.android.youtube.tv", "au.com.stan.and"), c.kiosk.allowed)
        assertEquals("03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4", c.kiosk.pinSha256)
        assertEquals(listOf("com.netflix.ninja", "com.google.android.youtube.tv"), c.pinned)
        assertTrue(c.welcome.enabled)
        assertTrue(c.welcome.showOnBoot)
        assertEquals("Welcome to Beach House", c.welcome.title)
        assertEquals("We hope you enjoy your stay.", c.welcome.message)
        assertEquals(LauncherConfig.Wifi("BeachHouse-Guest", "sunny-days", WifiSecurity.WPA), c.welcome.wifi)
        assertEquals(2, c.welcome.sections.size)
        assertEquals(LauncherConfig.Section("Checkout", "Please check out by 10 am."), c.welcome.sections[0])
        assertEquals("Questions? Text Nik on 0400 000 000", c.welcome.contact)
        assertFalse(c.showWelcome)
    }

    @Test
    fun base64RoundTripReportsShaOfTheJsonBytes() {
        val bytes = docExample.toByteArray(Charsets.UTF_8)
        val r = ConfigParser.fromBase64(Base64.getEncoder().encodeToString(bytes))
        r as ConfigResult.Ok
        assertEquals(Hashing.sha256Hex(bytes), r.sha256)
        assertEquals(64, r.sha256.length)
        assertTrue(r.json.contentEquals(bytes))
    }

    @Test
    fun base64AcceptsWhitespaceMissingPaddingAndUrlAlphabet() {
        val json = """{"v":1,"site_name":"??>>"}""".toByteArray()
        val std = Base64.getEncoder().encodeToString(json)
        assertTrue(ConfigParser.fromBase64(std.chunked(10).joinToString("\n")) is ConfigResult.Ok)
        assertTrue(ConfigParser.fromBase64(Base64.getEncoder().withoutPadding().encodeToString(json)) is ConfigResult.Ok)
        assertTrue(ConfigParser.fromBase64(Base64.getUrlEncoder().encodeToString(json)) is ConfigResult.Ok)
    }

    @Test
    fun base64Errors() {
        assertEquals("missing config_b64 extra", (ConfigParser.fromBase64(null) as ConfigResult.Error).message)
        assertEquals("config_b64 is empty", (ConfigParser.fromBase64("  ") as ConfigResult.Error).message)
        assertEquals("config_b64 is not valid base64", (ConfigParser.fromBase64("!!!") as ConfigResult.Error).message)
        val huge = "A".repeat(ConfigParser.MAX_BASE64_CHARS + 1)
        assertTrue((ConfigParser.fromBase64(huge) as ConfigResult.Error).message.startsWith("config too large"))
    }

    @Test
    fun rejectsOversizedJson() {
        val padding = " ".repeat(ConfigParser.MAX_JSON_BYTES)
        assertTrue(error("""{"v":1}$padding""").startsWith("config too large"))
        // Exactly at the cap is fine.
        val base = """{"v":1}"""
        ok(base + " ".repeat(ConfigParser.MAX_JSON_BYTES - base.length))
    }

    @Test
    fun rejectsInvalidUtf8AndNonObjects() {
        val r = ConfigParser.fromBytes(byteArrayOf('{'.code.toByte(), 0xC3.toByte(), '}'.code.toByte()))
        assertEquals("config is not valid UTF-8", (r as ConfigResult.Error).message)
        assertEquals("config must be a JSON object", error("[1]"))
        assertTrue(error("{nope").startsWith("invalid JSON"))
    }

    @Test
    fun requiresAKnownVersion() {
        // v2 (docs/LAUNCHER-V2.md) is now accepted too; see ConfigParserV2Test.
        assertEquals("v: missing (expected 1 or 2)", error("""{"site_name":"x"}"""))
        assertEquals("v: unsupported config version 3", error("""{"v":3}"""))
        assertEquals("v: unsupported config version 0", error("""{"v":0}"""))
        assertEquals("v: expected number", error("""{"v":"1"}"""))
        assertEquals(1, ok("""{"v":1.0}""").version)
    }

    @Test
    fun minimalConfigUsesSensibleDefaults() {
        val c = ok("""{"v":1}""")
        assertEquals("", c.siteName)
        assertEquals(LauncherConfig.DEFAULT_ACCENT, c.accentArgb)
        assertFalse(c.kiosk.enabled)
        assertTrue(c.kiosk.allowed.isEmpty())
        assertNull(c.kiosk.pinSha256)
        assertTrue(c.pinned.isEmpty())
        // A config has arrived, so welcome defaults on; with no config at all it is off.
        assertTrue(c.welcome.enabled)
        assertTrue(c.welcome.showOnBoot)
        assertNull(c.welcome.wifi)
        assertFalse(LauncherConfig.DEFAULT.welcome.enabled)
        assertFalse(LauncherConfig.DEFAULT.kiosk.enabled)
    }

    @Test
    fun ignoresUnknownFieldsAndTreatsNullAsUnset() {
        val c = ok(
            """{"v":1,"future":{"x":[1,2]},"accent":null,"kiosk":{"enabled":null,"pin_sha256":null,"extra":1},
               "welcome":{"wifi":null,"sections":null,"bogus":"y"},"pinned":null}""",
        )
        assertEquals(LauncherConfig.DEFAULT_ACCENT, c.accentArgb)
        assertFalse(c.kiosk.enabled)
        assertNull(c.kiosk.pinSha256)
        assertNull(c.welcome.wifi)
        assertTrue(c.welcome.sections.isEmpty())
    }

    @Test
    fun typeErrorsNameTheField() {
        assertEquals("site_name: expected string", error("""{"v":1,"site_name":5}"""))
        assertEquals("kiosk: expected object", error("""{"v":1,"kiosk":true}"""))
        assertEquals("kiosk.enabled: expected boolean", error("""{"v":1,"kiosk":{"enabled":"yes"}}"""))
        assertEquals("kiosk.allowed: expected array", error("""{"v":1,"kiosk":{"allowed":"com.a.b"}}"""))
        assertEquals("welcome.show_on_boot: expected boolean", error("""{"v":1,"welcome":{"show_on_boot":1}}"""))
        assertEquals("welcome.sections[1]: expected object", error("""{"v":1,"welcome":{"sections":[{},"x"]}}"""))
        assertEquals("show_welcome: expected boolean", error("""{"v":1,"show_welcome":"true"}"""))
    }

    @Test
    fun validatesPackageNames() {
        val good = listOf("com.netflix.ninja", "au.com.stan.and", "a.b", "com.google.android.youtube.tv", "org.x_y.Z9")
        good.forEach { assertTrue(it, ConfigParser.isValidPackageName(it)) }
        val bad = listOf("", "netflix", "com..netflix", ".com.x", "com.x.", "1com.x", "com.1x", "com.x-y", "com.x;rm", "com x.y", "com.x/y")
        bad.forEach { assertFalse(it, ConfigParser.isValidPackageName(it)) }
        assertFalse(ConfigParser.isValidPackageName("a." + "b".repeat(254)))

        assertEquals("kiosk.allowed[1]: invalid package name", error("""{"v":1,"kiosk":{"allowed":["com.ok.app","bad"]}}"""))
        assertEquals("pinned[0]: expected string", error("""{"v":1,"pinned":[1]}"""))
        assertEquals("pinned[0]: invalid package name", error("""{"v":1,"pinned":["com.x;reboot"]}"""))
    }

    @Test
    fun dedupesPackageListsAndCapsTheirSize() {
        val c = ok("""{"v":1,"pinned":["com.a.b","com.c.d","com.a.b"]}""")
        assertEquals(listOf("com.a.b", "com.c.d"), c.pinned)
        val many = (0..ConfigParser.MAX_PACKAGES).joinToString(",") { "\"com.app.p$it\"" }
        assertEquals("pinned: more than ${ConfigParser.MAX_PACKAGES} entries", error("""{"v":1,"pinned":[$many]}"""))
    }

    @Test
    fun validatesPinHash() {
        assertEquals("kiosk.pin_sha256: expected 64 hex characters or null", error("""{"v":1,"kiosk":{"pin_sha256":"1234"}}"""))
        assertEquals("kiosk.pin_sha256: expected 64 hex characters or null", error("""{"v":1,"kiosk":{"pin_sha256":""}}"""))
        assertEquals("kiosk.pin_sha256: expected 64 hex characters or null", error("""{"v":1,"kiosk":{"pin_sha256":"${"g".repeat(64)}"}}"""))
    }

    @Test
    fun validatesAccent() {
        assertEquals(0xFF112233.toInt(), ok("""{"v":1,"accent":"#112233"}""").accentArgb)
        assertEquals(0x80112233.toInt(), ok("""{"v":1,"accent":"#80112233"}""").accentArgb)
        for (bad in listOf("red", "#123", "112233", "#12345G", "#1122334")) {
            assertEquals("accent: expected #RRGGBB or #AARRGGBB", error("""{"v":1,"accent":"$bad"}"""))
        }
    }

    @Test
    fun wifiSecurityRules() {
        fun wifi(body: String) = ok("""{"v":1,"welcome":{"wifi":$body}}""").welcome.wifi
        assertEquals(WifiSecurity.WPA, wifi("""{"ssid":"a","password":"p","security":"wpa2"}""")?.security)
        assertEquals(WifiSecurity.WEP, wifi("""{"ssid":"a","password":"p","security":"WEP"}""")?.security)
        assertEquals(LauncherConfig.Wifi("a", "", WifiSecurity.NOPASS), wifi("""{"ssid":"a","password":"ignored","security":"nopass"}"""))
        assertEquals(WifiSecurity.NOPASS, wifi("""{"ssid":"a"}""")?.security)
        assertEquals(WifiSecurity.WPA, wifi("""{"ssid":"a","password":"p"}""")?.security)
        assertNull(wifi("""{"ssid":"","password":""}"""))

        assertEquals("welcome.wifi.security: expected WPA, WEP or nopass", error("""{"v":1,"welcome":{"wifi":{"ssid":"a","password":"p","security":"SAE"}}}"""))
        assertEquals("welcome.wifi.password: required for WPA", error("""{"v":1,"welcome":{"wifi":{"ssid":"a","security":"WPA"}}}"""))
        assertEquals("welcome.wifi.ssid: required when a password is set", error("""{"v":1,"welcome":{"wifi":{"password":"p"}}}"""))
        assertEquals("welcome.wifi.ssid: longer than 32 bytes", error("""{"v":1,"welcome":{"wifi":{"ssid":"${"é".repeat(17)}"}}}"""))
        assertEquals("welcome.wifi.password: longer than 64 characters", error("""{"v":1,"welcome":{"wifi":{"ssid":"a","password":"${"x".repeat(65)}"}}}"""))
        assertEquals("welcome.wifi.ssid: contains control characters", error("""{"v":1,"welcome":{"wifi":{"ssid":"a\u0007b"}}}"""))
    }

    @Test
    fun cleansAndTruncatesDisplayText() {
        val long = "x".repeat(ConfigParser.MAX_SITE_NAME + 10)
        val c = ok("""{"v":1,"site_name":"$long","welcome":{"title":"  Hi\u0000 there\n ","message":"a\r\nb\n\n\n\nc\u0007"}}""")
        assertEquals(ConfigParser.MAX_SITE_NAME, c.siteName.codePointCount(0, c.siteName.length))
        assertTrue(c.siteName.endsWith("…"))
        assertEquals("Hi there", c.welcome.title)
        assertEquals("a\nb\n\nc", c.welcome.message)
        // Never splits a surrogate pair.
        val emoji = ConfigParser.cleanText("😀".repeat(10), 5, multiline = false)
        assertEquals("😀".repeat(4) + "…", emoji)
    }

    @Test
    fun keepsAtMostSixNonEmptySections() {
        val sections = (1..9).joinToString(",") { """{"title":"T$it","body":"B$it"}""" }
        val c = ok("""{"v":1,"welcome":{"sections":[{"title":"","body":""},$sections]}}""")
        assertEquals(ConfigParser.MAX_SECTIONS, c.welcome.sections.size)
        assertEquals("T1", c.welcome.sections.first().title)
    }

    @Test
    fun showWelcomeFlag() {
        assertTrue(ok("""{"v":1,"show_welcome":true}""").showWelcome)
        assertFalse(ok("""{"v":1,"show_welcome":false}""").showWelcome)
    }

    @Test
    fun parseColorHelper() {
        assertEquals(0xFFFFFFFF.toInt(), ConfigParser.parseColor("#ffffff"))
        assertNull(ConfigParser.parseColor("#fff"))
    }
}
