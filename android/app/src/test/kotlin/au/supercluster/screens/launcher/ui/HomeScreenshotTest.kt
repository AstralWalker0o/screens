package au.supercluster.screens.launcher.ui

import android.app.Application
import android.content.ComponentName
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.test.core.app.ApplicationProvider
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.robolectric.Shadows
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.onAllNodesWithText
import com.github.takahirom.roborazzi.ExperimentalRoborazziApi
import au.supercluster.screens.launcher.core.AppCandidate
import au.supercluster.screens.launcher.core.ConfigParser
import au.supercluster.screens.launcher.core.ConfigResult
import au.supercluster.screens.launcher.core.HomeLayout
import au.supercluster.screens.launcher.core.LauncherConfig
import au.supercluster.screens.launcher.data.ArtLoader
import au.supercluster.screens.launcher.data.NetworkKind
import au.supercluster.screens.launcher.data.NetworkStatus
import com.github.takahirom.roborazzi.captureRoboImage
import com.github.takahirom.roborazzi.captureScreenRoboImage
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.Locale
import java.util.TimeZone

/**
 * Renders the v2 home screen at 1920x1080 (960x540 dp at xhdpi, a 1080p TV) on the JVM with
 * Robolectric's native graphics, and writes PNGs (see `screens.snapshotDir` in build.gradle.kts).
 * The app list, layout and parser are the real ones; only the artwork comes from [TestArt].
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w960dp-h540dp-land-xhdpi")
@OptIn(ExperimentalTestApi::class, ExperimentalRoborazziApi::class)
@Suppress("DEPRECATION") // createComposeRule v1: its immediate dispatch keeps these tests simple
class HomeScreenshotTest {
    private val compose = createComposeRule()

    /**
     * The compose rule hosts content in a plain ComponentActivity. Registering it with
     * Robolectric's package manager here keeps `ui-test-manifest` out of the debug APK.
     */
    @get:Rule
    val rules: RuleChain = RuleChain.outerRule(RegisterHostActivity()).around(compose)

    private val own = "au.supercluster.screens.launcher"
    private val outDir = File(System.getProperty("screens.snapshotDir") ?: "build/outputs/snapshots")
    private lateinit var savedZone: TimeZone
    private lateinit var savedLocale: Locale

    /** 2026-11-26 08:31 UTC: the clock in the operator's screenshot. */
    private val fixedNow = 1_795_681_860_000L

    private val apps = listOf(
        app("org.jellyfin.androidtv", "Jellyfin"),
        app("au.com.kayo.ott", "Kayo"),
        app("com.netflix.ninja", "Netflix"),
        app("com.plexapp.android", "Plex (Media Server)"),
        app("com.amazon.amazonvideo.livingroom", "Prime Video"),
        app("com.google.android.youtube.tv", "YouTube"),
        app("com.spotify.tv.android", "Spotify"),
        app("com.sonos.acr2", "Sonos"),
        app("com.nvidia.geforcenow", "GeForce NOW"),
        app("com.retroarch", "RetroArch"),
        app("com.android.vending", "Google Play Store"),
        app("tv.abc.iview", "ABC iview"),
        app("au.com.stan.and", "Stan"),
        app("com.android.tv.settings", "Settings", leanback = false),
        app("com.google.android.apps.tv.launcherx", "Google TV"),
        app(own, "Screens"),
    )

    private fun app(pkg: String, label: String, leanback: Boolean = true) = AppCandidate(pkg, "$pkg.Main", label, leanback)

    private val sampleConfig: LauncherConfig by lazy {
        val json = javaClass.getResourceAsStream("/config-v2-sample.json")!!.readBytes()
        (ConfigParser.fromBytes(json) as ConfigResult.Ok).config
    }

    private val wallpaperSha get() = sampleConfig.home!!.wallpaper!!.asset.sha256
    private val jellyfinArtSha get() = sampleConfig.home!!.tiles.getValue("org.jellyfin.androidtv").asset!!.sha256

    @Before
    fun setUp() {
        savedZone = TimeZone.getDefault()
        savedLocale = Locale.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
        Locale.setDefault(Locale.forLanguageTag("en-AU"))
        outDir.mkdirs()
    }

    @After
    fun tearDown() {
        TimeZone.setDefault(savedZone)
        Locale.setDefault(savedLocale)
    }

    private fun art(withWallpaper: Boolean): FakeArtSource {
        val images = HashMap<String, Bitmap>()
        if (withWallpaper) {
            // Through a real JPEG and the app's own decoder, like a pushed asset.
            val jpeg = File.createTempFile("wallpaper", ".jpg")
            jpeg.outputStream().use { TestArt.wallpaper().compress(Bitmap.CompressFormat.JPEG, 92, it) }
            val decoded = ArtLoader.decodeCover(jpeg, 1920, 1080)
            assertNotNull("wallpaper decodes", decoded)
            assertEquals(1920, decoded!!.width)
            assertEquals(1080, decoded.height)
            images[wallpaperSha] = decoded
            jpeg.delete()
        }
        // Custom tile art for Jellyfin (the config's `tiles` override).
        images[jellyfinArtSha] = TestArt.banner("jellyfin", 0xFF0B1026.toInt(), 0xFF1E1A4A.toInt(), mark = 0xFF8E63E6.toInt())
        val banners = mapOf(
            "au.com.kayo.ott" to TestArt.banner("KAYO", 0xFF0E0F12.toInt(), 0xFF1D2026.toInt(), text = 0xFF4CFF7A.toInt()),
            "com.netflix.ninja" to TestArt.banner("NETFLIX", 0xFF050505.toInt(), 0xFF141414.toInt(), text = 0xFFE50914.toInt()),
            "com.plexapp.android" to TestArt.banner("plex", 0xFF1F2326.toInt(), 0xFF2B3035.toInt(), mark = 0xFFE5A00D.toInt()),
            "com.amazon.amazonvideo.livingroom" to TestArt.banner("prime video", 0xFF0F2333.toInt(), 0xFF1A98FF.toInt()),
            "com.google.android.youtube.tv" to TestArt.banner("YouTube", 0xFF181818.toInt(), 0xFF262626.toInt(), mark = 0xFFFF0033.toInt()),
            "tv.abc.iview" to TestArt.banner("iview", 0xFF101010.toInt(), 0xFF2A2A2A.toInt()),
            "au.com.stan.and" to TestArt.banner("Stan.", 0xFF0A2BFF.toInt(), 0xFF0019A8.toInt()),
            "com.google.android.apps.tv.launcherx" to TestArt.banner("Google TV", 0xFF202124.toInt(), 0xFF303134.toInt()),
        )
        val icons = mapOf(
            "com.spotify.tv.android" to TestArt.icon("S", 0xFF1DB954.toInt()),
            "com.nvidia.geforcenow" to TestArt.icon("G", 0xFF76B900.toInt()),
            "com.retroarch" to TestArt.icon("R", 0xFF5C6BC0.toInt()),
            "com.android.vending" to TestArt.icon("P", 0xFF01875F.toInt()),
            "com.android.tv.settings" to TestArt.icon("⚙", 0xFF5F6368.toInt()),
        )
        return FakeArtSource(banners, icons, images)
    }

    private fun show(config: LauncherConfig, art: ArtSource, stored: Set<String>, network: NetworkStatus = NetworkStatus(NetworkKind.WIFI, 4)) {
        val home = config.home!!
        val rows = HomeLayout.build(apps, config, own, Locale.ENGLISH)
        compose.setContent {
            CompositionLocalProvider(LocalArtSource provides art, LocalNow provides { fixedNow }) {
                ScreensTheme(accent = Color(config.accentArgb)) {
                    HomeScreen(
                        home = home,
                        rows = rows,
                        storedAssets = stored,
                        kiosk = config.kiosk.enabled,
                        pinRequired = config.kiosk.enabled && config.kiosk.pinSha256 != null,
                        network = network,
                        homeRequests = 0,
                        verifyPin = { false },
                        onLaunch = {},
                        onOpenSettings = {},
                    )
                }
            }
        }
        settle()
    }

    private fun settle() {
        compose.waitForIdle()
        compose.mainClock.advanceTimeBy(1_000)
        compose.waitForIdle()
    }

    private fun press(key: Key) = press(listOf(key))

    private fun press(keys: List<Key>) {
        keys.forEach { key ->
            compose.onRoot().performKeyInput { pressKey(key) }
            settle()
        }
    }

    private fun shoot(name: String) = compose.onRoot().captureRoboImage(File(outDir, "$name.png").path)

    @Test
    fun home_firstCardGetsFocusOnceAppsLoad() {
        // The app list arrives after the first frame on a real box: focus must land on the first
        // card, not stay on the gear.
        val config = sampleConfig
        val loaded = androidx.compose.runtime.mutableStateOf<List<au.supercluster.screens.launcher.core.HomeRow>?>(null)
        compose.setContent {
            CompositionLocalProvider(LocalArtSource provides art(withWallpaper = false), LocalNow provides { fixedNow }) {
                ScreensTheme(accent = Color(config.accentArgb)) {
                    HomeScreen(
                        home = config.home!!,
                        rows = loaded.value,
                        storedAssets = emptySet(),
                        kiosk = false,
                        pinRequired = false,
                        network = NetworkStatus(NetworkKind.WIFI),
                        homeRequests = 0,
                        verifyPin = { false },
                        onLaunch = {},
                        onOpenSettings = {},
                    )
                }
            }
        }
        settle()
        compose.runOnIdle { loaded.value = HomeLayout.build(apps, config, own, Locale.ENGLISH) }
        settle()
        assertFocusedCard(text = "Jellyfin") // no art stored: the fallback card shows the name
    }

    /** The focused node is the card for [description] (banner/art) or [text] (fallback card). */
    private fun assertFocusedCard(description: String? = null, text: String? = null) {
        val focused = compose.onNode(isFocused())
        if (description != null) focused.assert(hasAnyDescendant(hasContentDescription(description)))
        if (text != null) focused.assert(hasAnyDescendant(hasText(text)))
    }

    @Test
    fun home_featuredRowFocused() {
        show(sampleConfig, art(withWallpaper = true), setOf(wallpaperSha, jellyfinArtSha))
        compose.onNodeWithText("8:31").assertIsDisplayed()
        compose.onNodeWithText("InterNik").assertIsDisplayed()
        assertFocusedCard(description = "Jellyfin")
        shoot("home_v2_featured")
    }

    @Test
    fun home_mediaRowFocused() {
        show(sampleConfig, art(withWallpaper = true), setOf(wallpaperSha, jellyfinArtSha))
        press(listOf(Key.DirectionDown, Key.DirectionRight, Key.DirectionRight))
        // Down keeps column 0 (Kayo), two rights reach Plex, shown with its `tiles` label override.
        assertFocusedCard(description = "Plex")
        shoot("home_v2_media_row")
    }

    @Test
    fun home_allAppsRowFocused() {
        show(sampleConfig, art(withWallpaper = true), setOf(wallpaperSha, jellyfinArtSha))
        press(List(4) { Key.DirectionDown })
        compose.onNodeWithText("All apps").assertIsDisplayed()
        assertFocusedCard(description = "ABC iview")
        compose.onAllNodesWithText("Google Play Store").assertCountEquals(0) // `hidden`
        shoot("home_v2_all_apps")
    }

    @Test
    fun home_fallbacksKioskAndOtherCardStyles() {
        // No wallpaper pushed yet (missing asset → built-in gradient), kiosk on, labels always,
        // icon and poster rows, and apps without banners (tinted fallback cards).
        val base = sampleConfig
        val config = base.copy(
            kiosk = LauncherConfig.Kiosk(
                enabled = true,
                allowed = listOf(
                    "org.jellyfin.androidtv", "com.netflix.ninja", "com.spotify.tv.android", "com.sonos.acr2",
                    "com.nvidia.geforcenow", "com.retroarch", "tv.abc.iview", "au.com.stan.and", "com.android.tv.settings",
                ),
                pinSha256 = "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4",
            ),
            home = base.home!!.copy(
                topBar = base.home!!.topBar.copy(date = true, clock24h = true),
                rows = listOf(
                    base.home!!.rows[2].copy(card = au.supercluster.screens.launcher.core.CardStyle.POSTER, size = au.supercluster.screens.launcher.core.CardSize.SMALL),
                    base.home!!.rows[3].copy(size = au.supercluster.screens.launcher.core.CardSize.LARGE),
                    base.home!!.rows[1],
                ),
                focus = LauncherConfig.Focus(scale = 1.15f, label = au.supercluster.screens.launcher.core.LabelMode.ALWAYS),
            ),
        )
        show(config, art(withWallpaper = false), stored = emptySet(), network = NetworkStatus(NetworkKind.ETHERNET))
        compose.onNodeWithText("08:31").assertIsDisplayed()
        compose.onAllNodesWithText("Kayo").assertCountEquals(0) // not in kiosk.allowed
        shoot("home_v2_fallbacks_kiosk")
    }

    @Test
    fun home_kioskPinDialogFromTheGear() {
        val config = sampleConfig.copy(
            kiosk = LauncherConfig.Kiosk(
                enabled = true,
                allowed = listOf("org.jellyfin.androidtv", "au.com.kayo.ott", "com.netflix.ninja", "com.plexapp.android"),
                pinSha256 = "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4",
            ),
        )
        show(config, art(withWallpaper = true), setOf(wallpaperSha, jellyfinArtSha))
        press(Key.DirectionUp) // first row → settings gear
        press(Key.DirectionCenter) // gear → PIN dialog (kiosk)
        compose.onNodeWithText("Enter PIN").assertIsDisplayed()
        captureScreenRoboImage(File(outDir, "home_v2_kiosk_pin.png").path)
    }
}

/** v1 configs (no `home`) keep the v1 grid; checks it still renders with the lazy art loader. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w960dp-h540dp-land-xhdpi")
@Suppress("DEPRECATION") // createComposeRule v1, as above
class V1GridScreenshotTest {
    private val compose = createComposeRule()

    @get:Rule
    val rules: RuleChain = RuleChain.outerRule(RegisterHostActivity()).around(compose)

    @Test
    fun v1_gridStillRenders() {
        val config = (
            ConfigParser.fromBytes(
                """{"v":1,"site_name":"Beach House","pinned":["com.netflix.ninja"],"kiosk":{"enabled":false}}""".toByteArray(),
            ) as ConfigResult.Ok
            ).config
        val candidates = listOf(
            AppCandidate("com.netflix.ninja", "a.Main", "Netflix", true),
            AppCandidate("com.google.android.youtube.tv", "b.Main", "YouTube", true),
            AppCandidate("com.spotify.tv.android", "c.Main", "Spotify", true),
            AppCandidate("tv.abc.iview", "d.Main", "ABC iview", true),
        )
        val apps = au.supercluster.screens.launcher.core.AppSelector.select(candidates, config, null, Locale.ENGLISH)
            .map { au.supercluster.screens.launcher.data.InstalledApp(it) }
        val art = FakeArtSource(
            banners = mapOf(
                "com.netflix.ninja" to TestArt.banner("NETFLIX", 0xFF050505.toInt(), 0xFF141414.toInt(), text = 0xFFE50914.toInt()),
                "com.google.android.youtube.tv" to TestArt.banner("YouTube", 0xFF181818.toInt(), 0xFF262626.toInt(), mark = 0xFFFF0033.toInt()),
                "tv.abc.iview" to TestArt.banner("iview", 0xFF101010.toInt(), 0xFF2A2A2A.toInt()),
            ),
            icons = mapOf("com.spotify.tv.android" to TestArt.icon("S", 0xFF1DB954.toInt())),
            images = emptyMap(),
        )
        val zone = TimeZone.getDefault()
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
        compose.setContent {
            CompositionLocalProvider(LocalArtSource provides art, LocalNow provides { 1_795_681_860_000L }) {
                ScreensTheme(accent = Color(config.accentArgb)) {
                    LauncherScreen(
                        siteName = config.siteName,
                        kiosk = false,
                        pinRequired = false,
                        apps = apps,
                        homeRequests = 0,
                        verifyPin = { false },
                        onLaunch = {},
                        onOpenSettings = {},
                    )
                }
            }
        }
        compose.waitForIdle()
        compose.onNodeWithText("Beach House").assertIsDisplayed()
        compose.onNodeWithText("Settings").assertIsDisplayed()
        val outDir = File(System.getProperty("screens.snapshotDir") ?: "build/outputs/snapshots").apply { mkdirs() }
        compose.onRoot().captureRoboImage(File(outDir, "home_v1_grid.png").path)
        TimeZone.setDefault(zone)
    }
}

/** Makes `androidx.activity.ComponentActivity` resolvable, as `ui-test-manifest` would. */
class RegisterHostActivity : ExternalResource() {
    override fun before() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        Shadows.shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
    }
}
