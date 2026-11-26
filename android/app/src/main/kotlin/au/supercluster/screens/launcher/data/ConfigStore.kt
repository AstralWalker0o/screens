package au.supercluster.screens.launcher.data

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import androidx.core.util.AtomicFile
import au.supercluster.screens.launcher.core.ConfigParser
import au.supercluster.screens.launcher.core.ConfigResult
import au.supercluster.screens.launcher.core.LauncherConfig
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import java.io.File
import java.io.IOException

/**
 * Process-wide source of truth for the stored config and the "welcome pending" flag.
 *
 * The config JSON is kept verbatim in the app's private `filesDir/config.json` (written
 * atomically) so that `config_sha` always matches what the gateway sent. It is re-validated
 * on load; an unreadable or invalid file falls back to [LauncherConfig.DEFAULT].
 * Receivers and activities share one process, so they observe changes through [state].
 */
object ConfigStore {
    data class State(
        val config: LauncherConfig,
        /** SHA-256 hex of the stored JSON, or null when no valid config is stored. */
        val configSha: String?,
        val welcomePending: Boolean,
    )

    private const val CONFIG_FILE = "config.json"
    private const val PREFS = "launcher_state"
    private const val KEY_WELCOME_PENDING = "welcome_pending"

    private val lock = Any()

    @Volatile
    private var flow: MutableStateFlow<State>? = null

    /** Always the same instance, so Compose collectors aren't restarted on recomposition. */
    fun state(context: Context): StateFlow<State> = ensure(context)

    fun current(context: Context): State = ensure(context).value

    /** Persists a validated config. Throws [IOException] if it can't be written. */
    @Throws(IOException::class)
    fun save(context: Context, ok: ConfigResult.Ok, showWelcome: Boolean) {
        val app = context.applicationContext
        synchronized(lock) {
            val file = AtomicFile(configFile(app))
            val out = file.startWrite()
            try {
                out.write(ok.json)
                file.finishWrite(out)
            } catch (e: IOException) {
                file.failWrite(out)
                throw e
            }
            if (showWelcome) prefs(app).edit(commit = true) { putBoolean(KEY_WELCOME_PENDING, true) }
            ensure(app).update {
                State(ok.config.copy(showWelcome = false), ok.sha256, it.welcomePending || showWelcome)
            }
        }
    }

    fun setWelcomePending(context: Context, pending: Boolean) {
        val app = context.applicationContext
        synchronized(lock) {
            if (ensure(app).value.welcomePending == pending) return
            prefs(app).edit(commit = true) { putBoolean(KEY_WELCOME_PENDING, pending) }
            ensure(app).update { it.copy(welcomePending = pending) }
        }
    }

    private fun ensure(context: Context): MutableStateFlow<State> {
        flow?.let { return it }
        synchronized(lock) {
            flow?.let { return it }
            return MutableStateFlow(load(context.applicationContext)).also { flow = it }
        }
    }

    private fun load(app: Context): State {
        val bytes = try {
            AtomicFile(configFile(app)).readFully()
        } catch (e: IOException) {
            null // no config yet (FileNotFoundException) or unreadable
        }
        val result = bytes?.let { ConfigParser.fromBytes(it) }
        val pending = prefs(app).getBoolean(KEY_WELCOME_PENDING, false)
        return if (result is ConfigResult.Ok) {
            State(result.config.copy(showWelcome = false), result.sha256, pending)
        } else {
            State(LauncherConfig.DEFAULT, null, pending)
        }
    }

    /** Tests only: forget the in-memory state (each Robolectric test has a fresh app). */
    @androidx.annotation.VisibleForTesting
    internal fun resetForTests() {
        synchronized(lock) { flow = null }
    }

    private fun configFile(app: Context) = File(app.filesDir, CONFIG_FILE)

    private fun prefs(app: Context): SharedPreferences = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
