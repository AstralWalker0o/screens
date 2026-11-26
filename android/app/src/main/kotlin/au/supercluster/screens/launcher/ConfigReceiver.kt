package au.supercluster.screens.launcher

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import au.supercluster.screens.launcher.core.ConfigParser
import au.supercluster.screens.launcher.core.ConfigResult
import au.supercluster.screens.launcher.core.LastErrorPolicy
import au.supercluster.screens.launcher.core.StatusReport
import au.supercluster.screens.launcher.data.AssetStore
import au.supercluster.screens.launcher.data.ConfigStore
import au.supercluster.screens.launcher.data.Diagnostics
import au.supercluster.screens.launcher.data.HomeStatus
import java.io.IOException

/**
 * Receives config and status queries from the Screens gateway over adb.
 *
 * Protected in the manifest by `android.permission.DUMP`, which the adb shell holds and normal
 * apps can't, so only adb / the system can reach it. Replies through the ordered-broadcast result:
 * `1` + `ok:<sha256>` / `status:{…}`, or `0` + `error:<message>`.
 */
class ConfigReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val (code, data) = try {
            when (intent.action) {
                ACTION_CONFIG -> applyConfig(context, intent)
                ACTION_STATUS -> RESULT_OK to status(context).toResultData()
                else -> RESULT_ERROR to "error:unknown action"
            }
        } catch (e: Exception) {
            Log.w(TAG, "broadcast failed", e)
            RESULT_ERROR to "error:internal ${e.javaClass.simpleName}"
        }
        if (isOrderedBroadcast) {
            resultCode = code
            resultData = data
        }
    }

    private fun applyConfig(context: Context, intent: Intent): Pair<Int, String> {
        val b64 = try {
            intent.getStringExtra(EXTRA_CONFIG_B64)
        } catch (e: RuntimeException) {
            null // malformed extras bundle
        }
        return when (val result = ConfigParser.fromBase64(b64)) {
            is ConfigResult.Error -> {
                Log.w(TAG, "config rejected: ${result.message}")
                Diagnostics.record(context, LastErrorPolicy.configRejected(result.message))
                RESULT_ERROR to "error:" + oneLine(result.message)
            }
            is ConfigResult.Ok -> {
                val showWelcome = result.config.showWelcome || intent.getBooleanExtra(EXTRA_SHOW_WELCOME, false)
                try {
                    ConfigStore.save(context, result, showWelcome)
                } catch (e: IOException) {
                    Diagnostics.record(context, LastErrorPolicy.configRejected("could not store config"))
                    return RESULT_ERROR to "error:could not store config"
                }
                // Unreferenced assets get 24 h from now before cleanup. A config that references
                // assets we don't have is still applied: the UI falls back and STATUS lists them.
                AssetStore.onConfigApplied(context)
                val referenced = result.config.referencedAssets()
                val stored = AssetStore.storedShas(context)
                Diagnostics.update(context) { LastErrorPolicy.afterConfigApplied(it, referenced, stored) }
                // Never log the config itself: it contains the guest Wi-Fi password.
                Log.i(TAG, "config applied sha=${result.sha256} v=${result.config.version} show_welcome=$showWelcome missing_assets=${(referenced - stored).size}")
                RESULT_OK to "ok:${result.sha256}"
            }
        }
    }

    private fun status(context: Context): StatusReport {
        // A `content write` that just returned may still be verifying; let it land first.
        AssetStore.awaitIdle(STATUS_WAIT_MILLIS)
        AssetStore.cleanup(context)
        val state = ConfigStore.current(context)
        val stored = AssetStore.storedShas(context)
        val referenced = state.config.referencedAssets()
        return StatusReport(
            version = BuildConfig.VERSION_NAME,
            versionCode = BuildConfig.VERSION_CODE.toLong(),
            configSha = state.configSha,
            configVersion = state.configSha?.let { state.config.version },
            isHome = HomeStatus.isDefaultHome(context),
            assets = stored.toList(),
            missingAssets = (referenced - stored).toList(),
            lastError = Diagnostics.lastError(context)?.message,
        )
    }

    private fun oneLine(s: String) = s.replace(Regex("[\\r\\n\\t]+"), " ").take(300)

    companion object {
        const val ACTION_CONFIG = "au.supercluster.screens.launcher.CONFIG"
        const val ACTION_STATUS = "au.supercluster.screens.launcher.STATUS"
        const val EXTRA_CONFIG_B64 = "config_b64"
        const val EXTRA_SHOW_WELCOME = "show_welcome"
        const val RESULT_OK = 1
        const val RESULT_ERROR = 0
        private const val TAG = "ScreensConfig"
        private const val STATUS_WAIT_MILLIS = 3_000L
    }
}
