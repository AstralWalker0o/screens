package au.supercluster.screens.launcher.data

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.graphics.Bitmap
import android.graphics.drawable.Drawable
import android.os.Build
import androidx.annotation.WorkerThread
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.core.graphics.drawable.toBitmap
import au.supercluster.screens.launcher.core.AppCandidate
import au.supercluster.screens.launcher.core.AppSelector

/** A launchable app with its artwork, ready to show. */
class InstalledApp(
    val candidate: AppCandidate,
    val banner: ImageBitmap?,
    val icon: ImageBitmap?,
) {
    val key: String get() = candidate.packageName
    val label: String get() = candidate.label

    fun launchIntent(): Intent = Intent(Intent.ACTION_MAIN)
        .addCategory(if (candidate.leanback) Intent.CATEGORY_LEANBACK_LAUNCHER else Intent.CATEGORY_LAUNCHER)
        .setComponent(ComponentName(candidate.packageName, candidate.activityName))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
}

/** Queries PackageManager for LEANBACK_LAUNCHER and LAUNCHER activities (visible via `<queries>`). */
class AppRepository(context: Context) {
    private val pm: PackageManager = context.applicationContext.packageManager
    private val artCache = HashMap<String, Pair<ImageBitmap?, ImageBitmap?>>()

    @WorkerThread
    @Synchronized
    fun loadInstalled(): List<InstalledApp> {
        val resolved = LinkedHashMap<String, Pair<ResolveInfo, Boolean>>()
        for ((category, leanback) in listOf(Intent.CATEGORY_LEANBACK_LAUNCHER to true, Intent.CATEGORY_LAUNCHER to false)) {
            for (ri in query(category)) {
                val ai = ri.activityInfo ?: continue
                if (!ai.enabled || ai.applicationInfo?.enabled == false) continue
                resolved.putIfAbsent("${ai.packageName}/${ai.name}/$leanback", ri to leanback)
            }
        }
        val candidates = resolved.map { (key, value) ->
            val (ri, leanback) = value
            key to AppCandidate(
                packageName = ri.activityInfo.packageName,
                activityName = ri.activityInfo.name,
                label = runCatching { ri.loadLabel(pm).toString() }.getOrDefault(ri.activityInfo.packageName),
                leanback = leanback,
            )
        }
        val infoByCandidate = candidates.associate { (key, c) -> c to resolved.getValue(key).first }

        val liveKeys = HashSet<String>()
        val apps = AppSelector.dedupe(candidates.map { it.second }).map { c ->
            val ri = infoByCandidate.getValue(c)
            val artKey = "${c.packageName}/${c.activityName}@${lastUpdate(c.packageName)}"
            liveKeys.add(artKey)
            val (banner, icon) = artCache.getOrPut(artKey) { loadArt(ri) }
            InstalledApp(c, banner, icon)
        }
        artCache.keys.retainAll(liveKeys)
        return apps
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

    /** Banner (activity, then application), falling back to the icon. */
    private fun loadArt(ri: ResolveInfo): Pair<ImageBitmap?, ImageBitmap?> {
        val ai = ri.activityInfo
        val banner: Drawable? = runCatching { ai.loadBanner(pm) }.getOrNull()
            ?: runCatching { pm.getApplicationBanner(ai.applicationInfo) }.getOrNull()
        if (banner != null) {
            return render(banner, BANNER_W, BANNER_H) to null
        }
        val icon = runCatching { ri.loadIcon(pm) }.getOrNull()
        return null to icon?.let { render(it, ICON_PX, ICON_PX) }
    }

    private fun render(d: Drawable, w: Int, h: Int): ImageBitmap? =
        runCatching { d.toBitmap(w, h, Bitmap.Config.ARGB_8888).asImageBitmap() }.getOrNull()

    private companion object {
        const val BANNER_W = 384
        const val BANNER_H = 216
        const val ICON_PX = 160
    }
}
