package au.supercluster.screens.launcher.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ConfigParserV2Test {
    private val sha1 = "a".repeat(64)
    private val sha2 = "0123456789abcdef".repeat(4)

    /** The example from docs/LAUNCHER-V2.md §2, verbatim apart from the two `<sha256>` placeholders. */
    private val docExample = """
        {
          "v": 2,
          "site_name": "Theatre",
          "accent": "#4F8EF7",
          "home": {
            "wallpaper": { "asset": "$sha1", "ext": "jpg", "dim": 0.25 },
            "top_bar": { "clock": true, "clock_24h": false, "date": false, "network": true, "settings": true },
            "rows": [
              { "id": "featured", "title": "InterNik", "icon": "bookmark", "card": "banner", "size": "large",
                "apps": ["org.jellyfin.androidtv"] },
              { "id": "media", "title": "Media", "icon": "media", "card": "banner", "size": "medium",
                "apps": ["au.com.kayo.ott", "com.netflix.ninja", "com.plexapp.android", "com.amazon.amazonvideo.livingroom", "com.google.android.youtube.tv"] }
            ],
            "all_apps": { "enabled": true, "title": "All apps" },
            "hidden": ["com.android.vending"],
            "tiles": { "com.plexapp.android": { "label": "Plex", "asset": "$sha2", "ext": "png" } },
            "focus": { "scale": 1.12, "label": "focused" }
          },
          "kiosk":   { "enabled": false, "allowed": [], "pin_sha256": null },
          "pinned":  [],
          "welcome": { "enabled": false, "show_on_boot": false, "title": "", "message": "", "wifi": null, "sections": [], "contact": "" }
        }
    """.trimIndent()

    private fun ok(json: String): LauncherConfig = ConfigParser.parse(json)

    private fun error(json: String): String = when (val r = ConfigParser.fromBytes(json.toByteArray())) {
        is ConfigResult.Error -> r.message
        is ConfigResult.Ok -> fail("expected an error for: $json") as Nothing
    }

    /** A minimal valid v2 config with [home] spliced in as the `home` object body. */
    private fun v2(home: String) = """{"v":2,"home":{$home}}"""

    private val oneRow = """"rows":[{"id":"r","apps":["com.a.b"]}]"""

    private fun homeOf(homeBody: String): LauncherConfig.Home = ok(v2(homeBody)).home!!

    @Test
    fun parsesTheDocumentedExample() {
        val c = ok(docExample)
        assertEquals(2, c.version)
        assertEquals("Theatre", c.siteName)
        val home = c.home!!
        assertEquals(LauncherConfig.Wallpaper(AssetRef(sha1, AssetExt.JPG), 0.25f), home.wallpaper)
        assertEquals(LauncherConfig.TopBar(clock = true, clock24h = false, date = false, network = true, settings = true), home.topBar)
        assertEquals(2, home.rows.size)
        assertEquals(
            LauncherConfig.Row("featured", "InterNik", RowIcon.BOOKMARK, CardStyle.BANNER, CardSize.LARGE, listOf("org.jellyfin.androidtv")),
            home.rows[0],
        )
        assertEquals("media", home.rows[1].id)
        assertEquals(CardSize.MEDIUM, home.rows[1].size)
        assertEquals(5, home.rows[1].apps.size)
        assertEquals(LauncherConfig.AllApps(enabled = true, title = "All apps"), home.allApps)
        assertEquals(listOf("com.android.vending"), home.hidden)
        assertEquals(mapOf("com.plexapp.android" to LauncherConfig.Tile("Plex", AssetRef(sha2, AssetExt.PNG))), home.tiles)
        assertEquals(LauncherConfig.Focus(1.12f, LabelMode.FOCUSED), home.focus)
        assertEquals(setOf(sha1, sha2), c.referencedAssets())
        assertFalse(c.kiosk.enabled)
        assertFalse(c.welcome.enabled)
    }

    @Test
    fun parsesTheSampleConfigShippedForTests() {
        val json = javaClass.getResourceAsStream("/config-v2-sample.json")!!.readBytes()
        val r = ConfigParser.fromBytes(json) as ConfigResult.Ok
        val home = r.config.home!!
        assertEquals(listOf("featured", "media", "music", "games"), home.rows.map { it.id })
        assertEquals(CardStyle.ICON, home.rows[3].card)
        assertEquals(2, r.config.referencedAssets().size)
    }

    @Test
    fun v2WithoutHomeBehavesLikeV1() {
        val c = ok("""{"v":2,"site_name":"x","pinned":["com.a.b"]}""")
        assertEquals(2, c.version)
        assertNull(c.home)
        assertEquals(listOf("com.a.b"), c.pinned)
        assertNull(ok("""{"v":2,"home":null}""").home)
    }

    @Test
    fun v1IgnoresHomeAsAnUnknownField() {
        val c = ok("""{"v":1,"home":{"rows":"not even valid"}}""")
        assertEquals(1, c.version)
        assertNull(c.home)
        assertTrue(c.referencedAssets().isEmpty())
    }

    @Test
    fun rejectsUnknownVersions() {
        assertEquals("v: unsupported config version 3", error("""{"v":3}"""))
        assertEquals("v: unsupported config version 2.5", error("""{"v":2.5}"""))
        assertEquals(2, ok("""{"v":2.0}""").version)
    }

    @Test
    fun minimalHomeUsesDefaults() {
        val home = homeOf(oneRow)
        assertNull(home.wallpaper)
        assertEquals(LauncherConfig.TopBar(), home.topBar)
        assertNull(home.topBar.clock24h) // follow the device setting
        assertEquals(LauncherConfig.Row("r", "", RowIcon.NONE, CardStyle.BANNER, CardSize.MEDIUM, listOf("com.a.b")), home.rows.single())
        assertEquals(LauncherConfig.AllApps(enabled = true, title = ""), home.allApps)
        assertTrue(home.hidden.isEmpty())
        assertTrue(home.tiles.isEmpty())
        assertEquals(LauncherConfig.Focus(LauncherConfig.DEFAULT_FOCUS_SCALE, LabelMode.FOCUSED), home.focus)
    }

    @Test
    fun rowCountLimits() {
        assertEquals("home.rows: missing (expected 1 to 12 rows)", error(v2("")))
        assertEquals("home.rows: expected 1 to 12 rows", error(v2(""""rows":[]""")))
        val twelve = (1..12).joinToString(",") { """{"id":"r$it"}""" }
        assertEquals(12, homeOf(""""rows":[$twelve]""").rows.size)
        val thirteen = (1..13).joinToString(",") { """{"id":"r$it"}""" }
        assertEquals("home.rows: expected 1 to 12 rows", error(v2(""""rows":[$thirteen]""")))
        assertEquals("home.rows[0]: expected object", error(v2(""""rows":[null]""")))
    }

    @Test
    fun rowIdRules() {
        for (good in listOf("a", "media", "row_1", "my-row", "x".repeat(32), "0")) {
            assertEquals(good, homeOf(""""rows":[{"id":"$good"}]""").rows.single().id)
        }
        for (bad in listOf("", "Media", "a b", "a.b", "x".repeat(33), "é", ":all_apps")) {
            assertEquals(bad, "home.rows[0].id: expected 1 to 32 of a-z, 0-9, _ and -", error(v2(""""rows":[{"id":"$bad"}]""")))
        }
        assertEquals("home.rows[0].id: missing", error(v2(""""rows":[{"title":"x"}]""")))
        assertEquals("home.rows[1].id: duplicate id \"a\"", error(v2(""""rows":[{"id":"a"},{"id":"a"}]""")))
    }

    @Test
    fun rowAppsLimitDedupeAndPackageRule() {
        val forty = (1..40).joinToString(",") { "\"com.app.p$it\"" }
        assertEquals(40, homeOf(""""rows":[{"id":"r","apps":[$forty]}]""").rows.single().apps.size)
        val fortyOne = (1..41).joinToString(",") { "\"com.app.p$it\"" }
        assertEquals("home.rows[0].apps: more than 40 entries", error(v2(""""rows":[{"id":"r","apps":[$fortyOne]}]""")))
        assertEquals(
            listOf("com.a.b", "com.c.d"),
            homeOf(""""rows":[{"id":"r","apps":["com.a.b","com.c.d","com.a.b"]}]""").rows.single().apps,
        )
        assertEquals("home.rows[0].apps[1]: invalid package name", error(v2(""""rows":[{"id":"r","apps":["com.a.b","nodots"]}]""")))
        // v2 uses the contract's (slightly wider) package rule everywhere, kiosk and pinned included.
        assertEquals(listOf("com.1x"), homeOf(""""rows":[{"id":"r","apps":["com.1x"]}]""").rows.single().apps)
        assertEquals(listOf("com._x"), ok("""{"v":2,"kiosk":{"allowed":["com._x"]}}""").kiosk.allowed)
        assertEquals("pinned[0]: invalid package name", error("""{"v":1,"pinned":["com.1x"]}"""))
        assertTrue(ConfigParser.isValidPackageNameV2("au.com.kayo.ott"))
        assertFalse(ConfigParser.isValidPackageNameV2("1com.x"))
        assertFalse(ConfigParser.isValidPackageNameV2("com..x"))
        assertFalse(ConfigParser.isValidPackageNameV2("com.x-y"))
    }

    @Test
    fun rowEnumsAreStrict() {
        for (icon in RowIcon.entries) {
            assertEquals(icon, homeOf(""""rows":[{"id":"r","icon":"${icon.token}"}]""").rows.single().icon)
        }
        assertEquals(
            "home.rows[0].icon: expected one of bookmark, media, star, tv, music, games, kids, settings, apps, none",
            error(v2(""""rows":[{"id":"r","icon":"sports"}]""")),
        )
        assertEquals("home.rows[0].card: expected one of banner, icon, poster", error(v2(""""rows":[{"id":"r","card":"Banner"}]""")))
        assertEquals("home.rows[0].size: expected one of small, medium, large", error(v2(""""rows":[{"id":"r","size":"xl"}]""")))
        assertEquals("home.rows[0].size: expected string", error(v2(""""rows":[{"id":"r","size":2}]""")))
        assertEquals(CardStyle.POSTER, homeOf(""""rows":[{"id":"r","card":"poster","size":"small"}]""").rows.single().card)
    }

    @Test
    fun rowTitlesAreCleanedAndTruncatedToForty() {
        val home = homeOf(""""rows":[{"id":"r","title":"  ${"x".repeat(50)}\u0007 "}]""")
        val title = home.rows.single().title
        assertEquals(ConfigParser.MAX_ROW_TITLE, title.codePointCount(0, title.length))
        assertTrue(title.endsWith("…"))
        assertEquals("Hi there", homeOf(""""rows":[{"id":"r","title":"Hi\nthere"}]""").rows.single().title)
    }

    @Test
    fun wallpaperRules() {
        val w = homeOf(""""wallpaper":{"asset":"${sha1.uppercase()}","ext":"PNG"},$oneRow""").wallpaper!!
        assertEquals(AssetRef(sha1, AssetExt.PNG), w.asset)
        assertEquals(LauncherConfig.DEFAULT_DIM, w.dim)
        assertEquals(0f, homeOf(""""wallpaper":{"asset":"$sha1","ext":"webp","dim":0},$oneRow""").wallpaper!!.dim)
        assertEquals(0.8f, homeOf(""""wallpaper":{"asset":"$sha1","ext":"webp","dim":0.8},$oneRow""").wallpaper!!.dim)
        assertNull(homeOf(""""wallpaper":null,$oneRow""").wallpaper)

        assertEquals("home.wallpaper.dim: expected a number from 0 to 0.8", error(v2(""""wallpaper":{"asset":"$sha1","ext":"jpg","dim":0.81},$oneRow""")))
        assertEquals("home.wallpaper.dim: expected a number from 0 to 0.8", error(v2(""""wallpaper":{"asset":"$sha1","ext":"jpg","dim":-0.1},$oneRow""")))
        assertEquals("home.wallpaper.dim: expected number", error(v2(""""wallpaper":{"asset":"$sha1","ext":"jpg","dim":"0.2"},$oneRow""")))
        assertEquals("home.wallpaper.asset: missing (expected 64 hex characters)", error(v2(""""wallpaper":{"ext":"jpg"},$oneRow""")))
        assertEquals("home.wallpaper.asset: expected 64 hex characters", error(v2(""""wallpaper":{"asset":"${"a".repeat(63)}","ext":"jpg"},$oneRow""")))
        assertEquals("home.wallpaper.asset: expected 64 hex characters", error(v2(""""wallpaper":{"asset":"../../etc/passwd","ext":"jpg"},$oneRow""")))
        assertEquals("home.wallpaper.ext: missing (expected jpg, png or webp)", error(v2(""""wallpaper":{"asset":"$sha1"},$oneRow""")))
        assertEquals("home.wallpaper.ext: expected jpg, png or webp", error(v2(""""wallpaper":{"asset":"$sha1","ext":"jpeg"},$oneRow""")))
        assertEquals("home.wallpaper.ext: expected jpg, png or webp", error(v2(""""wallpaper":{"asset":"$sha1","ext":"gif"},$oneRow""")))
    }

    @Test
    fun topBarRules() {
        val t = homeOf(""""top_bar":{"clock":false,"clock_24h":true,"date":true,"network":false,"settings":false},$oneRow""").topBar
        assertEquals(LauncherConfig.TopBar(clock = false, clock24h = true, date = true, network = false, settings = false), t)
        assertEquals("home.top_bar.clock: expected boolean", error(v2(""""top_bar":{"clock":"yes"},$oneRow""")))
        assertEquals("home.top_bar: expected object", error(v2(""""top_bar":true,$oneRow""")))
    }

    @Test
    fun focusRules() {
        assertEquals(1.0f, homeOf(""""focus":{"scale":1},$oneRow""").focus.scale)
        assertEquals(1.25f, homeOf(""""focus":{"scale":1.25},$oneRow""").focus.scale)
        assertEquals(LabelMode.ALWAYS, homeOf(""""focus":{"label":"always"},$oneRow""").focus.label)
        assertEquals(LabelMode.NEVER, homeOf(""""focus":{"label":"never"},$oneRow""").focus.label)
        assertEquals("home.focus.scale: expected a number from 1.0 to 1.25", error(v2(""""focus":{"scale":1.3},$oneRow""")))
        assertEquals("home.focus.scale: expected a number from 1.0 to 1.25", error(v2(""""focus":{"scale":0.9},$oneRow""")))
        assertEquals("home.focus.label: expected one of always, focused, never", error(v2(""""focus":{"label":"hover"},$oneRow""")))
    }

    @Test
    fun allAppsAndHidden() {
        val home = homeOf(""""all_apps":{"enabled":false,"title":"Everything"},"hidden":["com.x.y","com.x.y","com.z.w"],$oneRow""")
        assertEquals(LauncherConfig.AllApps(enabled = false, title = "Everything"), home.allApps)
        assertEquals(listOf("com.x.y", "com.z.w"), home.hidden)
        assertEquals("home.hidden[0]: invalid package name", error(v2(""""hidden":["x"],$oneRow""")))
        assertEquals("home.all_apps.enabled: expected boolean", error(v2(""""all_apps":{"enabled":1},$oneRow""")))
    }

    @Test
    fun tileOverrides() {
        val home = homeOf(
            """"tiles":{
                 "com.a.b":{"label":"  Short  "},
                 "com.c.d":{"asset":"$sha2","ext":"webp"},
                 "com.e.f":{"label":"${"y".repeat(60)}","asset":"$sha1","ext":"jpg"},
                 "com.g.h":{},
                 "com.i.j":null
               },$oneRow""",
        )
        assertEquals(LauncherConfig.Tile("Short", null), home.tiles["com.a.b"])
        assertEquals(LauncherConfig.Tile("", AssetRef(sha2, AssetExt.WEBP)), home.tiles["com.c.d"])
        val long = home.tiles["com.e.f"]!!
        assertEquals(ConfigParser.MAX_TILE_LABEL, long.label.codePointCount(0, long.label.length))
        assertEquals(AssetRef(sha1, AssetExt.JPG), long.asset)
        // Empty or null overrides change nothing, so they aren't kept.
        assertEquals(setOf("com.a.b", "com.c.d", "com.e.f"), home.tiles.keys)
        assertEquals(setOf(sha1, sha2), home.referencedAssets())

        assertEquals("home.tiles: invalid package name \"not a package\"", error(v2(""""tiles":{"not a package":{"label":"x"}},$oneRow""")))
        assertEquals("home.tiles.com.a.b: expected object", error(v2(""""tiles":{"com.a.b":"Plex"},$oneRow""")))
        assertEquals("home.tiles.com.a.b.ext: missing (expected jpg, png or webp)", error(v2(""""tiles":{"com.a.b":{"asset":"$sha1"}},$oneRow""")))
        assertEquals("home.tiles.com.a.b.asset: missing (expected 64 hex characters)", error(v2(""""tiles":{"com.a.b":{"ext":"png"}},$oneRow""")))
    }

    @Test
    fun referencedAssetsCoverWallpaperAndTiles() {
        val c = ok(v2(""""wallpaper":{"asset":"$sha1","ext":"jpg"},"tiles":{"com.a.b":{"asset":"$sha1","ext":"jpg"},"com.c.d":{"asset":"$sha2","ext":"png"}},$oneRow"""))
        assertEquals(setOf(sha1, sha2), c.referencedAssets())
        assertTrue(ok("""{"v":1}""").referencedAssets().isEmpty())
    }
}
