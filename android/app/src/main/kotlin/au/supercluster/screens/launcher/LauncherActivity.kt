package au.supercluster.screens.launcher

import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import au.supercluster.screens.launcher.core.AppCandidate
import au.supercluster.screens.launcher.core.AppSelector
import au.supercluster.screens.launcher.core.HomeLayout
import au.supercluster.screens.launcher.core.Pin
import au.supercluster.screens.launcher.data.AppRepository
import au.supercluster.screens.launcher.data.ArtLoader
import au.supercluster.screens.launcher.data.AssetStore
import au.supercluster.screens.launcher.data.ConfigStore
import au.supercluster.screens.launcher.data.InstalledApp
import au.supercluster.screens.launcher.data.NetworkMonitor
import au.supercluster.screens.launcher.data.launchIntent
import au.supercluster.screens.launcher.ui.HomeScreen
import au.supercluster.screens.launcher.ui.LauncherScreen
import au.supercluster.screens.launcher.ui.LocalArtSource
import au.supercluster.screens.launcher.ui.ScreensTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The home screen (HOME + LEANBACK_LAUNCHER, singleTask).
 *
 * With a v2 config that has `home` it shows [HomeScreen] (wallpaper, top bar, rows of cards);
 * otherwise the v1 grid of allowed apps in configured order. Either way it hands over to
 * [WelcomeActivity] whenever "welcome pending" is set (at boot, or by a CONFIG broadcast with
 * `show_welcome`).
 */
class LauncherActivity : ComponentActivity() {

    private lateinit var repository: AppRepository
    private var installed by mutableStateOf<List<InstalledApp>?>(null)
    private var homeRequests by mutableIntStateOf(0)
    private var loadJob: Job? = null

    private val packageReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) = reloadApps()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        repository = AppRepository(this)

        // Back on the launcher does nothing.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = Unit
        })

        ContextCompat.registerReceiver(
            this,
            packageReceiver,
            IntentFilter().apply {
                addAction(Intent.ACTION_PACKAGE_ADDED)
                addAction(Intent.ACTION_PACKAGE_REMOVED)
                addAction(Intent.ACTION_PACKAGE_CHANGED)
                addAction(Intent.ACTION_PACKAGE_REPLACED)
                addDataScheme("package")
            },
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )

        val artLoader = ArtLoader.get(this)
        setContent {
            val state by ConfigStore.state(this).collectAsStateWithLifecycle()
            val config = state.config
            val apps = installed
            val home = config.home
            CompositionLocalProvider(LocalArtSource provides artLoader) {
                ScreensTheme(accent = Color(config.accentArgb)) {
                    if (home != null) {
                        // v2: rows of cards over a wallpaper (docs/LAUNCHER-V2.md).
                        val assets by AssetStore.state(this).collectAsStateWithLifecycle()
                        val storedAssets = remember(assets) { assets.keys.toSet() }
                        val network by NetworkMonitor.state(this).collectAsStateWithLifecycle()
                        val rows = remember(apps, config) {
                            apps?.let { list -> HomeLayout.build(list.map { it.candidate }, config, packageName) }
                        }
                        HomeScreen(
                            home = home,
                            rows = rows,
                            storedAssets = storedAssets,
                            kiosk = config.kiosk.enabled,
                            pinRequired = Pin.isRequired(config),
                            network = network,
                            homeRequests = homeRequests,
                            verifyPin = { Pin.matches(it, config.kiosk.pinSha256) },
                            onLaunch = { launch(it.app) },
                            onOpenSettings = ::openSettings,
                        )
                    } else {
                        // v1 (or no config yet): the grid.
                        val visible = remember(apps, config) {
                            apps?.let { list ->
                                val byPackage = list.associateBy { it.candidate.packageName }
                                AppSelector.select(list.map { it.candidate }, config, packageName)
                                    .mapNotNull { byPackage[it.packageName] }
                            }
                        }
                        LauncherScreen(
                            siteName = config.siteName,
                            kiosk = config.kiosk.enabled,
                            pinRequired = Pin.isRequired(config),
                            apps = visible,
                            homeRequests = homeRequests,
                            verifyPin = { Pin.matches(it, config.kiosk.pinSha256) },
                            onLaunch = { launch(it.candidate) },
                            onOpenSettings = ::openSettings,
                        )
                    }
                }
            }
        }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.RESUMED) {
                ConfigStore.state(this@LauncherActivity).collect { state ->
                    if (state.welcomePending) {
                        ConfigStore.setWelcomePending(this@LauncherActivity, false)
                        if (state.config.welcome.enabled) {
                            startActivity(Intent(this@LauncherActivity, WelcomeActivity::class.java))
                        }
                    }
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        reloadApps() // apps may have changed while we weren't listening
        // Unreferenced assets expire 24 h after a config change; home resumes often, so check here.
        lifecycleScope.launch(Dispatchers.IO) { runCatching { AssetStore.cleanup(this@LauncherActivity) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.hasCategory(Intent.CATEGORY_HOME)) homeRequests++
    }

    override fun onDestroy() {
        runCatching { unregisterReceiver(packageReceiver) }
        super.onDestroy()
    }

    private fun reloadApps() {
        loadJob?.cancel()
        loadJob = lifecycleScope.launch {
            installed = withContext(Dispatchers.IO) { repository.loadInstalled() }
        }
    }

    private fun launch(app: AppCandidate) {
        try {
            startActivity(app.launchIntent())
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, getString(R.string.cannot_open_app, app.label), Toast.LENGTH_SHORT).show()
            reloadApps()
        } catch (e: SecurityException) {
            Toast.makeText(this, getString(R.string.cannot_open_app, app.label), Toast.LENGTH_SHORT).show()
        }
    }

    private fun openSettings() {
        try {
            startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, R.string.cannot_open_settings, Toast.LENGTH_SHORT).show()
        }
    }
}
