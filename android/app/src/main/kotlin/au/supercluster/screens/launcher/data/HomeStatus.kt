package au.supercluster.screens.launcher.data

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build

object HomeStatus {
    /** True when CATEGORY_HOME currently resolves to this app (i.e. it is the default home screen). */
    fun isDefaultHome(context: Context): Boolean {
        val pm = context.packageManager
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        val info = try {
            if (Build.VERSION.SDK_INT >= 33) {
                pm.resolveActivity(intent, PackageManager.ResolveInfoFlags.of(PackageManager.MATCH_DEFAULT_ONLY.toLong()))
            } else {
                @Suppress("DEPRECATION")
                pm.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY)
            }
        } catch (e: RuntimeException) {
            null
        }
        return info?.activityInfo?.packageName == context.packageName
    }
}
