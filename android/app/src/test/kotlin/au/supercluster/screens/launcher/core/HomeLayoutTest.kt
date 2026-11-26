package au.supercluster.screens.launcher.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

class HomeLayoutTest {
    private val own = "au.supercluster.screens.launcher"
    private val art = AssetRef("b".repeat(64), AssetExt.PNG)

    private fun app(pkg: String, label: String, leanback: Boolean = true, activity: String = "$pkg.Main") =
        AppCandidate(pkg, activity, label, leanback)

    private val installed = listOf(
        app("org.jellyfin.androidtv", "Jellyfin"),
        app("au.com.kayo.ott", "Kayo"),
        app("com.netflix.ninja", "Netflix"),
        app("com.plexapp.android", "Plex (Media Server)"),
        app("com.amazon.amazonvideo.livingroom", "Prime Video"),
        app("com.google.android.youtube.tv", "YouTube"),
        app("com.android.vending", "Google Play Store"),
        app("com.spotify.tv.android", "Spotify"),
        app("tv.abc.iview", "ABC iview"),
        app("com.android.tv.settings", "Settings", leanback = false),
        app(own, "Screens"),
    )

    private fun config(
        rows: List<LauncherConfig.Row>,
        allApps: LauncherConfig.AllApps = LauncherConfig.AllApps(),
        hidden: List<String> = emptyList(),
        tiles: Map<String, LauncherConfig.Tile> = emptyMap(),
        kiosk: LauncherConfig.Kiosk = LauncherConfig.Kiosk(),
    ) = LauncherConfig(
        version = 2,
        kiosk = kiosk,
        home = LauncherConfig.Home(rows = rows, allApps = allApps, hidden = hidden, tiles = tiles),
    )

    private val featured = LauncherConfig.Row("featured", "InterNik", RowIcon.BOOKMARK, CardStyle.BANNER, CardSize.LARGE, listOf("org.jellyfin.androidtv"))
    private val media = LauncherConfig.Row(
        "media", "Media", RowIcon.MEDIA, CardStyle.BANNER, CardSize.MEDIUM,
        listOf("au.com.kayo.ott", "com.netflix.ninja", "com.plexapp.android", "com.not.installed", "com.amazon.amazonvideo.livingroom", "com.google.android.youtube.tv"),
    )

    private fun build(c: LauncherConfig) = HomeLayout.build(installed, c, own, Locale.ENGLISH)

    private fun HomeRow.packages() = tiles.map { it.packageName }

    @Test
    fun rowsKeepConfiguredOrderAndSkipMissingPackages() {
        val rows = build(config(listOf(featured, media), allApps = LauncherConfig.AllApps(enabled = false)))
        assertEquals(listOf("featured", "media"), rows.map { it.key })
        assertEquals(listOf("org.jellyfin.androidtv"), rows[0].packages())
        assertEquals(
            listOf("au.com.kayo.ott", "com.netflix.ninja", "com.plexapp.android", "com.amazon.amazonvideo.livingroom", "com.google.android.youtube.tv"),
            rows[1].packages(),
        )
        assertEquals("InterNik", rows[0].title)
        assertEquals(RowIcon.BOOKMARK, rows[0].icon)
        assertEquals(CardSize.LARGE, rows[0].size)
    }

    @Test
    fun allAppsListsTheRestByLabelExcludingOwnPackageAndRowApps() {
        val rows = build(config(listOf(featured, media)))
        val all = rows.last()
        assertTrue(all.isAllApps)
        assertEquals(HomeLayout.ALL_APPS_KEY, all.key)
        assertEquals(RowIcon.APPS, all.icon)
        assertEquals(
            listOf("tv.abc.iview", "com.android.vending", "com.android.tv.settings", "com.spotify.tv.android"),
            all.packages(),
        )
    }

    @Test
    fun allAppsCanBeDisabledAndIsDroppedWhenEmpty() {
        assertEquals(listOf("featured"), build(config(listOf(featured), allApps = LauncherConfig.AllApps(enabled = false))).map { it.key })
        val everything = LauncherConfig.Row("all", "", RowIcon.NONE, CardStyle.ICON, CardSize.SMALL, installed.map { it.packageName })
        assertEquals(listOf("all"), build(config(listOf(everything))).map { it.key })
    }

    @Test
    fun hiddenAppsAppearNowhere() {
        val rows = build(config(listOf(featured, media), hidden = listOf("com.netflix.ninja", "com.android.vending", "org.jellyfin.androidtv")))
        // The featured row lost its only app, so it is dropped entirely (header included).
        assertEquals(listOf("media", HomeLayout.ALL_APPS_KEY), rows.map { it.key })
        rows.forEach { row ->
            assertTrue(row.packages().none { it in setOf("com.netflix.ninja", "com.android.vending", "org.jellyfin.androidtv") })
        }
    }

    @Test
    fun kioskFiltersRowsAndAllApps() {
        val kiosk = LauncherConfig.Kiosk(enabled = true, allowed = listOf("com.netflix.ninja", "com.google.android.youtube.tv", "tv.abc.iview"))
        val rows = build(config(listOf(featured, media), kiosk = kiosk))
        assertEquals(listOf("media", HomeLayout.ALL_APPS_KEY), rows.map { it.key })
        assertEquals(listOf("com.netflix.ninja", "com.google.android.youtube.tv"), rows[0].packages())
        assertEquals(listOf("tv.abc.iview"), rows[1].packages())
    }

    @Test
    fun kioskWithNothingAllowedShowsNothing() {
        val rows = build(config(listOf(featured, media), kiosk = LauncherConfig.Kiosk(enabled = true)))
        assertTrue(rows.isEmpty())
    }

    @Test
    fun hiddenWinsOverKioskAllowed() {
        val kiosk = LauncherConfig.Kiosk(enabled = true, allowed = listOf("com.netflix.ninja", "tv.abc.iview"))
        val rows = build(config(listOf(media), hidden = listOf("tv.abc.iview"), kiosk = kiosk))
        assertEquals(listOf("media"), rows.map { it.key })
        assertEquals(listOf("com.netflix.ninja"), rows.single().packages())
    }

    @Test
    fun tileOverridesChangeLabelArtAndAllAppsOrder() {
        val tiles = mapOf(
            "com.plexapp.android" to LauncherConfig.Tile(label = "Plex", asset = art),
            "com.spotify.tv.android" to LauncherConfig.Tile(label = "Aardvark Music"),
            "com.netflix.ninja" to LauncherConfig.Tile(asset = art),
        )
        val rows = build(config(listOf(media), tiles = tiles))
        val plex = rows[0].tiles.first { it.packageName == "com.plexapp.android" }
        assertEquals("Plex", plex.label)
        assertEquals(art, plex.art)
        val netflix = rows[0].tiles.first { it.packageName == "com.netflix.ninja" }
        assertEquals("Netflix", netflix.label) // no label override: the app's own label
        assertEquals(art, netflix.art)
        assertNull(rows[0].tiles.first { it.packageName == "au.com.kayo.ott" }.art)
        // All apps sorts by the label shown on screen.
        assertEquals("com.spotify.tv.android", rows.last().packages().first())
        assertEquals("Aardvark Music", rows.last().tiles.first().label)
    }

    @Test
    fun appMayAppearInSeveralRowsButOncePerRow() {
        val again = LauncherConfig.Row("again", "Again", RowIcon.STAR, CardStyle.ICON, CardSize.SMALL, listOf("org.jellyfin.androidtv", "org.jellyfin.androidtv", "com.netflix.ninja"))
        val rows = build(config(listOf(featured, again), allApps = LauncherConfig.AllApps(enabled = false)))
        assertEquals(listOf("org.jellyfin.androidtv"), rows[0].packages())
        assertEquals(listOf("org.jellyfin.androidtv", "com.netflix.ninja"), rows[1].packages())
    }

    @Test
    fun leanbackActivityWinsAndOwnPackageNeverShows() {
        val candidates = listOf(
            app("com.x.app", "X phone", leanback = false, activity = "com.x.app.Phone"),
            app("com.x.app", "X TV", leanback = true, activity = "com.x.app.Tv"),
            app(own, "Screens"),
        )
        val row = LauncherConfig.Row("r", "", RowIcon.NONE, CardStyle.BANNER, CardSize.MEDIUM, listOf("com.x.app", own))
        val rows = HomeLayout.build(candidates, config(listOf(row)), own, Locale.ENGLISH)
        assertEquals(1, rows.size)
        assertEquals("com.x.app.Tv", rows.single().tiles.single().app.activityName)
    }

    @Test
    fun noHomeMeansNoRows() {
        assertTrue(HomeLayout.build(installed, LauncherConfig(), own).isEmpty())
    }
}
