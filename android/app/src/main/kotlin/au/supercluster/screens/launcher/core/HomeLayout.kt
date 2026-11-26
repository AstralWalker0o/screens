package au.supercluster.screens.launcher.core

import java.text.Collator
import java.util.Locale

/** One app card on the v2 home screen. */
data class HomeTile(
    val app: AppCandidate,
    /** Display label: the `tiles` override, else the app's own label. */
    val label: String,
    /** Custom card art from `tiles`, shown instead of the app's banner when stored. */
    val art: AssetRef?,
) {
    val packageName: String get() = app.packageName
}

/** One visible row of the v2 home screen. */
data class HomeRow(
    /** The configured row id, or [HomeLayout.ALL_APPS_KEY]. */
    val key: String,
    /** Empty means "no title" (for All apps: the default "All apps" title). */
    val title: String,
    val icon: RowIcon,
    val card: CardStyle,
    val size: CardSize,
    val tiles: List<HomeTile>,
) {
    val isAllApps: Boolean get() = key == HomeLayout.ALL_APPS_KEY
}

/**
 * Turns `home.rows` + the installed apps into the rows the home screen shows
 * (docs/LAUNCHER-V2.md §2):
 *
 * - Packages that aren't installed are skipped silently; our own package is never shown.
 * - `home.hidden` packages are never shown, in any row or in All apps.
 * - With `kiosk.enabled`, only `kiosk.allowed` packages appear, in every row and in All apps.
 * - A package appears at most once per row (it may appear in several rows).
 * - Rows left with no apps are dropped, header included.
 * - All apps (if enabled) lists every remaining visible app not already shown in a row,
 *   sorted by display label, as the last row.
 */
object HomeLayout {
    /** Row key of All apps. Contains a character that configured row ids can't contain. */
    const val ALL_APPS_KEY = ":all_apps"

    val ALL_APPS_CARD = CardStyle.BANNER
    val ALL_APPS_SIZE = CardSize.SMALL

    fun build(
        candidates: Collection<AppCandidate>,
        config: LauncherConfig,
        ownPackage: String?,
        locale: Locale = Locale.getDefault(),
    ): List<HomeRow> {
        val home = config.home ?: return emptyList()
        val hidden = home.hidden.toHashSet()
        val allowed = config.kiosk.allowed.toHashSet()
        val visible = AppSelector.dedupe(candidates)
            .filter { app ->
                app.packageName != ownPackage &&
                    app.packageName !in hidden &&
                    (!config.kiosk.enabled || app.packageName in allowed)
            }
            .associateBy { it.packageName }

        fun tile(app: AppCandidate): HomeTile {
            val override = home.tiles[app.packageName]
            return HomeTile(
                app = app,
                label = override?.label?.takeIf { it.isNotEmpty() } ?: app.label,
                art = override?.asset,
            )
        }

        val shown = HashSet<String>()
        val rows = ArrayList<HomeRow>(home.rows.size + 1)
        for (row in home.rows) {
            val seen = HashSet<String>()
            val tiles = row.apps.mapNotNull { pkg -> visible[pkg]?.takeIf { seen.add(pkg) }?.let(::tile) }
            if (tiles.isEmpty()) continue
            shown.addAll(seen)
            rows.add(HomeRow(row.id, row.title, row.icon, row.card, row.size, tiles))
        }

        if (home.allApps.enabled) {
            val collator = Collator.getInstance(locale).apply { strength = Collator.SECONDARY }
            val rest = visible.values
                .filter { it.packageName !in shown }
                .map(::tile)
                .sortedWith { a, b ->
                    val byLabel = collator.compare(a.label.trim(), b.label.trim())
                    if (byLabel != 0) byLabel else a.packageName.compareTo(b.packageName)
                }
            if (rest.isNotEmpty()) {
                rows.add(HomeRow(ALL_APPS_KEY, home.allApps.title, RowIcon.APPS, ALL_APPS_CARD, ALL_APPS_SIZE, rest))
            }
        }
        return rows
    }
}
