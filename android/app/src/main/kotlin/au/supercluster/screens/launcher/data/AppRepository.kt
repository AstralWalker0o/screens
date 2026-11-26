package au.supercluster.screens.launcher.data

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.os.Build
import androidx.annotation.WorkerThread
import au.supercluster.screens.launcher.core.AppCandidate
import au.supercluster.screens.launcher.core.AppSelector

/**
 * A launchable app. Artwork is not loaded here: cards ask [ArtLoader] for it at the size they
 * draw it, keyed by [AppCandidate.updatedAt] so an app update brings its new banner.
 */
class InstalledApp(val candidate: AppCandidate) {
    val key: String get() = candidate.packageName
    val label: String get() = candidate.label

    fun launchIntent(): Intent = candidate.launchIntent()
}

fun AppCandidate.launchIntent(): Intent = Intent(Intent.ACTION_MAIN)
    .addCategory(if (leanback) Intent.CATEGORY_LEANBACK_LAUNCHER else Intent.CATEGORY_LAUNCHER)
    .setComponent(ComponentName(packageName, activityName))
    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)

/** Queries PackageManager for LEANBACK_LAUNCHER and LAUNCHER activities (visible via `<queries>`). */
class AppRepository(context: Context) {
    private val pm: PackageManager = context.applicationContext.packageManager

    /** One entry per package (leanback activity preferred). */
    @WorkerThread
    fun loadInstalled(): List<InstalledApp> {
        val resolved = LinkedHashMap<String, AppCandidate>()
        for ((category, leanback) in listOf(Intent.CATEGORY_LEANBACK_LAUNCHER to true, Intent.CATEGORY_LAUNCHER to false)) {
            for (ri in query(category)) {
                val ai = ri.activityInfo ?: continue
                if (!ai.enabled || ai.applicationInfo?.enabled == false) continue
                resolved.getOrPut("${ai.packageName}/${ai.name}/$leanback") {
                    AppCandidate(
                        packageName = ai.packageName,
                        activityName = ai.name,
                        label = runCatching { ri.loadLabel(pm).toString() }.getOrDefault(ai.packageName),
                        leanback = leanback,
                    )
                }
            }
        }
        return AppSelector.dedupe(resolved.values).map { InstalledApp(it.copy(updatedAt = lastUpdate(it.packageName))) }
    }

    private fun query(category: String): List<ResolveInfo> {
        val intent = Intent(Intent.ACTION_MAIN).addCategory(category)
        return try {
            if (Build.VERSION.SDK_INT >= 33) {
                pm.queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION")
                pm.queryIntentActivities(intent, 0)
            }
        } catch (e: RuntimeException) {
            emptyList()
        }
    }

    private fun lastUpdate(packageName: String): Long = try {
        if (Build.VERSION.SDK_INT >= 33) {
            pm.getPackageInfo(packageName, PackageManager.PackageInfoFlags.of(0)).lastUpdateTime
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(packageName, 0).lastUpdateTime
        }
    } catch (e: PackageManager.NameNotFoundException) {
        0L
    }
}
