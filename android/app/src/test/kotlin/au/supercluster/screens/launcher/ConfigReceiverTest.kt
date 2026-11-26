package au.supercluster.screens.launcher

import android.app.Application
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import au.supercluster.screens.launcher.core.Hashing
import au.supercluster.screens.launcher.core.Json
import au.supercluster.screens.launcher.data.AssetStore
import au.supercluster.screens.launcher.data.ConfigStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.Base64

/** CONFIG and STATUS through the real receiver, as `am broadcast` sends them. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ConfigReceiverTest {
    private lateinit var app: Application

    @Before
    fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        AssetStore.resetForTests()
        ConfigStore.resetForTests()
    }

    @After
    fun tearDown() {
        AssetStore.resetForTests()
        ConfigStore.resetForTests()
    }

    /**
     * What `am broadcast -n …/.ConfigReceiver` gets back: (result code, result data). Calls the
     * receiver's handler directly (Robolectric doesn't route explicit broadcasts to a manifest
     * receiver without intent filters; the DUMP guard is a manifest attribute, checked on the APK).
     */
    private fun broadcast(action: String, configJson: String? = null): Pair<Int, String?> {
        val intent = Intent(action).setClassName(app, ConfigReceiver::class.java.name)
        if (configJson != null) {
            intent.putExtra(ConfigReceiver.EXTRA_CONFIG_B64, Base64.getEncoder().encodeToString(configJson.toByteArray()))
        }
        return ConfigReceiver().handle(app, intent)
    }

    private fun status(): Map<*, *> {
        val (code, data) = broadcast(ConfigReceiver.ACTION_STATUS)
        assertEquals(1, code)
        assertTrue(data!!.startsWith("status:"))
        return Json.parse(data.removePrefix("status:")) as Map<*, *>
    }

    @Test
    fun statusBeforeAnyConfig() {
        val s = status()
        assertEquals(BuildConfig.VERSION_NAME, s["version"])
        assertEquals(20000L, s["version_code"])
        assertNull(s["config_sha"])
        assertNull(s["config_v"])
        assertEquals(emptyList<Any>(), s["assets"])
        assertEquals(emptyList<Any>(), s["missing_assets"])
        assertNull(s["last_error"])
        assertTrue(s["is_home"] is Boolean) // true here: Robolectric's only HOME activity is ours
    }

    @Test
    fun v2ConfigWithMissingAssetsIsAcceptedAndReported() {
        val wallpaper = "d".repeat(64)
        val json = """{"v":2,"home":{"wallpaper":{"asset":"$wallpaper","ext":"jpg","dim":0.3},"rows":[{"id":"media","apps":["com.netflix.ninja"]}]}}"""
        val (code, data) = broadcast(ConfigReceiver.ACTION_CONFIG, json)
        assertEquals(1, code)
        assertEquals("ok:" + Hashing.sha256Hex(json.toByteArray()), data)

        val s = status()
        assertEquals(Hashing.sha256Hex(json.toByteArray()), s["config_sha"])
        assertEquals(2L, s["config_v"])
        assertEquals(listOf(wallpaper), s["missing_assets"])
        assertNull(s["last_error"])
    }

    @Test
    fun rejectedConfigSetsLastErrorAndAGoodOneClearsIt() {
        val (code, data) = broadcast(ConfigReceiver.ACTION_CONFIG, """{"v":2,"home":{"rows":[]}}""")
        assertEquals(0, code)
        assertEquals("error:home.rows: expected 1 to 12 rows", data)
        assertEquals("config: home.rows: expected 1 to 12 rows", status()["last_error"])

        val (ok, _) = broadcast(ConfigReceiver.ACTION_CONFIG, """{"v":1,"site_name":"Beach House"}""")
        assertEquals(1, ok)
        val s = status()
        assertNull(s["last_error"])
        assertEquals(1L, s["config_v"])
    }
}
