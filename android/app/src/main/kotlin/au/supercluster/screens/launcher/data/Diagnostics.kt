package au.supercluster.screens.launcher.data

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import au.supercluster.screens.launcher.core.LastError
import au.supercluster.screens.launcher.core.StatusReport

/**
 * Persists STATUS `last_error` (see [au.supercluster.screens.launcher.core.LastErrorPolicy]).
 * Messages never contain config contents: only field names, SHAs and sizes.
 */
object Diagnostics {
    private const val PREFS = "launcher_diagnostics"
    private const val KEY_MESSAGE = "last_error"
    private const val KEY_ASSET = "last_error_asset"
    private val lock = Any()

    fun lastError(context: Context): LastError? = synchronized(lock) {
        val p = prefs(context)
        p.getString(KEY_MESSAGE, null)?.let { LastError(it, p.getString(KEY_ASSET, null)) }
    }

    fun record(context: Context, error: LastError) = update(context) { error }

    /** Atomically replaces the stored error with [transform] of it. */
    fun update(context: Context, transform: (LastError?) -> LastError?) {
        synchronized(lock) {
            val current = lastError(context)
            val next = transform(current)?.let { it.copy(message = oneLine(it.message)) }
            if (next == current) return
            prefs(context).edit(commit = true) {
                if (next == null) {
                    remove(KEY_MESSAGE)
                    remove(KEY_ASSET)
                } else {
                    putString(KEY_MESSAGE, next.message)
                    if (next.assetSha == null) remove(KEY_ASSET) else putString(KEY_ASSET, next.assetSha)
                }
            }
        }
    }

    private fun oneLine(s: String) = s.replace(Regex("[\\r\\n\\t]+"), " ").take(StatusReport.MAX_LAST_ERROR)

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
