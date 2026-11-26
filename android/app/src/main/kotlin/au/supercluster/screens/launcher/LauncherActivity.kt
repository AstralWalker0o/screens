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
import au.supercluster.screens.launcher.core.AppSelector
import au.supercluster.screens.launcher.core.Pin
import au.supercluster.screens.launcher.data.AppRepository
import au.supercluster.screens.launcher.data.ConfigStore
import au.supercluster.screens.launcher.data.InstalledApp
import au.supercluster.screens.launcher.ui.LauncherScreen
import au.supercluster.screens.launcher.ui.ScreensTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The home screen (HOME + LEANBACK_LAUNCHER, singleTask).
 *
 * Shows the allowed apps in configured order, and hands over to [WelcomeActivity] whenever
 * "welcome pending" is set (at boot, or by a CONFIG broadcast with `show_welcome`).
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

        setContent {
            val state by ConfigStore.state(this).collectAsStateWithLifecycle()
            val config = state.config
            val apps = installed
            val visible = remember(apps, config) {
                apps?.let { list ->
                    val byPackage = list.associateBy { it.candidate.packageName }
                    AppSelector.select(list.map { it.candidate }, config, packageName)
                        .mapNotNull { byPackage[it.packageName] }
                }
            }
            ScreensTheme(accent = Color(config.accentArgb)) {
                LauncherScreen(
                    siteName = config.siteName,
                    kiosk = config.kiosk.enabled,
                    pinRequired = Pin.isRequired(config),
                    apps = visible,
                    homeRequests = homeRequests,
                    verifyPin = { Pin.matches(it, config.kiosk.pinSha256) },
                    onLaunch = ::launch,
                    onOpenSettings = ::openSettings,
                )
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

    private fun launch(app: InstalledApp) {
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
