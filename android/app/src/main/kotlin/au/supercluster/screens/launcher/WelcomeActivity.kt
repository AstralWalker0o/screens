package au.supercluster.screens.launcher

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import au.supercluster.screens.launcher.data.ConfigStore
import au.supercluster.screens.launcher.ui.ScreensTheme
import au.supercluster.screens.launcher.ui.WelcomeScreen

/**
 * Full-screen guest welcome. Exported without intent filters so the gateway can run
 * `am start -n au.supercluster.screens.launcher/.WelcomeActivity` after a guest reset.
 * "Start watching" (or Back) dismisses it to the launcher.
 */
class WelcomeActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ConfigStore.setWelcomePending(this, false)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = startWatching()
        })

        setContent {
            val state by ConfigStore.state(this).collectAsStateWithLifecycle()
            ScreensTheme(accent = Color(state.config.accentArgb)) {
                WelcomeScreen(config = state.config, onStart = ::startWatching)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        ConfigStore.setWelcomePending(this, false)
    }

    private fun startWatching() {
        // Started by `am start` we sit in our own task: bring the launcher forward explicitly.
        // Started by the launcher we sit on top of it, so finishing is enough.
        if (isTaskRoot) {
            runCatching {
                startActivity(Intent(this, LauncherActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }
        finish()
    }
}
