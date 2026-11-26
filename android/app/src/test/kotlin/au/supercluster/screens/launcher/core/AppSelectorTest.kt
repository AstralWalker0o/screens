package au.supercluster.screens.launcher.core

import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Locale

class AppSelectorTest {
    private val own = "au.supercluster.screens.launcher"

    private fun app(pkg: String, label: String, leanback: Boolean = true, activity: String = "$pkg.Main") =
        AppCandidate(pkg, activity, label, leanback)

    private val installed = listOf(
        app("com.netflix.ninja", "Netflix"),
        app("com.google.android.youtube.tv", "YouTube"),
        app("au.com.stan.and", "Stan"),
        app("com.plexapp.android", "Plex"),
        app("com.android.tv.settings", "Settings", leanback = false),
        app("com.amazon.amazonvideo.livingroom", "Prime Video"),
        app("tv.abc.iview", "ABC iview"),
        app(own, "Screens"),
    )

    private fun select(kiosk: Boolean, allowed: List<String> = emptyList(), pinned: List<String> = emptyList()) =
        AppSelector.select(installed, kiosk, allowed, pinned, own, Locale.ENGLISH).map { it.packageName }

    @Test
    fun kioskShowsOnlyAllowedInstalledAppsPinnedFirstThenByName() {
        val result = select(
            kiosk = true,
            allowed = listOf("com.netflix.ninja", "com.google.android.youtube.tv", "au.com.stan.and", "tv.abc.iview", "com.not.installed"),
            pinned = listOf("com.google.android.youtube.tv", "com.netflix.ninja"),
        )
        assertEquals(listOf("com.google.android.youtube.tv", "com.netflix.ninja", "tv.abc.iview", "au.com.stan.and"), result)
    }

    @Test
    fun kioskIgnoresPinnedAppsThatAreNotAllowed() {
        val result = select(kiosk = true, allowed = listOf("au.com.stan.and"), pinned = listOf("com.netflix.ninja", "au.com.stan.and"))
        assertEquals(listOf("au.com.stan.and"), result)
    }

    @Test
    fun kioskWithEmptyAllowListShowsNothing() {
        assertEquals(emptyList<String>(), select(kiosk = true, allowed = emptyList(), pinned = listOf("com.netflix.ninja")))
    }

    @Test
    fun withoutKioskShowsEverythingExceptOurselvesPinnedFirst() {
        val result = select(kiosk = false, allowed = listOf("com.netflix.ninja"), pinned = listOf("com.plexapp.android", "com.not.installed"))
        assertEquals(
            listOf(
                "com.plexapp.android",
                "tv.abc.iview",
                "com.netflix.ninja",
                "com.amazon.amazonvideo.livingroom",
                "com.android.tv.settings",
                "au.com.stan.and",
                "com.google.android.youtube.tv",
            ),
            result,
        )
    }

    @Test
    fun nameOrderIsCaseInsensitiveWithPackageTieBreak() {
        val apps = listOf(app("com.b.x", "beta"), app("com.a.x", "Alpha"), app("com.z.x", "alpha"), app("com.c.x", "Écran"))
        val result = AppSelector.select(apps, false, emptyList(), emptyList(), null, Locale.ENGLISH).map { it.packageName }
        assertEquals(listOf("com.a.x", "com.z.x", "com.b.x", "com.c.x"), result)
    }

    @Test
    fun dedupesPerPackagePreferringLeanback() {
        val apps = listOf(
            app("com.x.app", "X phone", leanback = false, activity = "com.x.app.Phone"),
            app("com.x.app", "X TV", leanback = true, activity = "com.x.app.Tv"),
            app("com.y.app", "Y", leanback = false, activity = "com.y.app.B"),
            app("com.y.app", "Y", leanback = false, activity = "com.y.app.A"),
        )
        val result = AppSelector.select(apps, false, emptyList(), emptyList(), null, Locale.ENGLISH)
        assertEquals(listOf("com.x.app.Tv", "com.y.app.A"), result.map { it.activityName })
    }

    @Test
    fun duplicatePinnedEntriesAppearOnce() {
        val result = select(kiosk = false, pinned = listOf("com.netflix.ninja", "com.netflix.ninja"))
        assertEquals("com.netflix.ninja", result.first())
        assertEquals(1, result.count { it == "com.netflix.ninja" })
    }

    @Test
    fun configOverloadUsesKioskAndPinnedFields() {
        val config = LauncherConfig(
            kiosk = LauncherConfig.Kiosk(enabled = true, allowed = listOf("au.com.stan.and", "com.netflix.ninja")),
            pinned = listOf("au.com.stan.and"),
        )
        val result = AppSelector.select(installed, config, own, Locale.ENGLISH).map { it.packageName }
        assertEquals(listOf("au.com.stan.and", "com.netflix.ninja"), result)
    }
}
