package au.supercluster.screens.launcher.core

import java.text.Collator
import java.util.Locale

/** A launchable activity found on the device (pure data, no Android types). */
data class AppCandidate(
    val packageName: String,
    val activityName: String,
    val label: String,
    /** Found via CATEGORY_LEANBACK_LAUNCHER (preferred) rather than CATEGORY_LAUNCHER. */
    val leanback: Boolean,
)

/**
 * Decides which apps the launcher shows, and in which order.
 *
 * - One tile per package; a leanback activity wins over a plain launcher activity.
 * - Our own package is never shown.
 * - Kiosk on: only packages in `kiosk.allowed`. Kiosk off: every launchable app.
 * - Order: packages in `pinned`, in that order, then the rest by label (locale collation),
 *   then package name as a tie-breaker.
 */
object AppSelector {

    fun select(
        candidates: Collection<AppCandidate>,
        config: LauncherConfig,
        ownPackage: String?,
        locale: Locale = Locale.getDefault(),
    ): List<AppCandidate> = select(
        candidates = candidates,
        kioskEnabled = config.kiosk.enabled,
        allowed = config.kiosk.allowed,
        pinned = config.pinned,
        ownPackage = ownPackage,
        locale = locale,
    )

    fun select(
        candidates: Collection<AppCandidate>,
        kioskEnabled: Boolean,
        allowed: Collection<String>,
        pinned: List<String>,
        ownPackage: String?,
        locale: Locale = Locale.getDefault(),
    ): List<AppCandidate> {
        val allowedSet = allowed.toHashSet()
        val visible = dedupe(candidates).filter { app ->
            app.packageName != ownPackage && (!kioskEnabled || app.packageName in allowedSet)
        }
        val byPackage = visible.associateBy { it.packageName }

        val result = ArrayList<AppCandidate>(visible.size)
        val placed = HashSet<String>()
        for (pkg in pinned) {
            val app = byPackage[pkg] ?: continue
            if (placed.add(pkg)) result.add(app)
        }
        val collator = Collator.getInstance(locale).apply { strength = Collator.SECONDARY }
        visible
            .filter { it.packageName !in placed }
            .sortedWith { a, b ->
                val byLabel = collator.compare(a.label.trim(), b.label.trim())
                if (byLabel != 0) byLabel else a.packageName.compareTo(b.packageName)
            }
            .forEach { result.add(it) }
        return result
    }

    /** One candidate per package: leanback first, then the alphabetically first activity. */
    fun dedupe(candidates: Collection<AppCandidate>): List<AppCandidate> =
        candidates
            .groupBy { it.packageName }
            .map { (_, group) ->
                group.minWith(compareBy<AppCandidate> { !it.leanback }.thenBy { it.activityName })
            }
}
