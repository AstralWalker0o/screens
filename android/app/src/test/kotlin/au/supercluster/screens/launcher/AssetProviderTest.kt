package au.supercluster.screens.launcher

import android.app.Application
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import au.supercluster.screens.launcher.core.AssetName
import au.supercluster.screens.launcher.core.ConfigParser
import au.supercluster.screens.launcher.core.ConfigResult
import au.supercluster.screens.launcher.core.Hashing
import au.supercluster.screens.launcher.data.AssetStore
import au.supercluster.screens.launcher.data.ConfigStore
import au.supercluster.screens.launcher.data.Diagnostics
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.io.PipedInputStream
import java.io.PipedOutputStream

/**
 * The assets provider end to end, as `content write` / `content query` / `content delete` drive
 * it: uploads are verified and stored, the listing shows them, bad paths and modes are refused.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AssetProviderTest {
    private lateinit var app: Application
    private lateinit var provider: AssetProvider
    private val authority = "au.supercluster.screens.launcher.assets"

    @Before
    fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        AssetStore.resetForTests()
        ConfigStore.resetForTests()
        provider = Robolectric.setupContentProvider(AssetProvider::class.java, authority)
    }

    @After
    fun tearDown() {
        AssetStore.resetForTests()
        ConfigStore.resetForTests()
    }

    private fun uri(path: String) = Uri.parse("content://$authority$path")

    /**
     * What `content write --uri … < file` does, through the provider's own upload path. The bytes
     * go through a blocking in-memory pipe: Robolectric's `createPipe` is a temporary file, which
     * can't model a writer that is slower than the reader (see AssetStore.uploadForTests).
     */
    private fun contentWrite(path: String, bytes: ByteArray) {
        val name = AssetName.parseUriPath(uri(path).encodedPath)!!
        val sink = PipedOutputStream()
        val source = PipedInputStream(sink, 64 * 1024)
        AssetStore.uploadForTests(app, name, source)
        try {
            sink.use { out ->
                var off = 0
                while (off < bytes.size) {
                    val n = minOf(32 * 1024, bytes.size - off)
                    out.write(bytes, off, n)
                    off += n
                }
            }
        } catch (e: IOException) {
            // The store stopped reading (over the size limit): like `content write`, carry on.
        }
        assertTrue("upload finished", AssetStore.awaitIdle(10_000))
    }

    @Test
    fun openFileHandsOutAWritableEndAndAnEmptyUploadIsRejected() {
        val sha = Hashing.sha256Hex(image(8))
        val pfd = provider.openFile(uri("/$sha.jpg"), "w")
        pfd.close() // the writer closes without sending anything
        assertTrue(AssetStore.awaitIdle(10_000))
        assertTrue(listing().isEmpty())
        assertEquals(
            "asset $sha: sha256 mismatch (received 0 bytes with sha256 ${Hashing.sha256Hex(ByteArray(0))})",
            Diagnostics.lastError(app)!!.message,
        )
    }

    private fun listing(path: String = "/"): List<Pair<String, Long>> {
        val c = provider.query(uri(path), null, null, null, null)
        return c.use {
            assertEquals(listOf("sha256", "bytes"), it.columnNames.toList())
            buildList { while (it.moveToNext()) add(it.getString(0) to it.getLong(1)) }
        }
    }

    private fun image(seed: Int, size: Int = 4096) = ByteArray(size) { (it * 7 + seed).toByte() }

    @Test
    fun writeVerifyAndList() {
        val a = image(1)
        val b = image(2, 100_000)
        val shaA = Hashing.sha256Hex(a)
        val shaB = Hashing.sha256Hex(b)
        contentWrite("/$shaA.jpg", a)
        contentWrite("/${shaB.uppercase()}.PNG", b)
        assertEquals(listOf(shaA to a.size.toLong(), shaB to b.size.toLong()).sortedBy { it.first }, listing())
        assertEquals(listOf(shaB to b.size.toLong()), listing("/$shaB.png"))
        assertEquals(listOf(shaB to b.size.toLong()), listing("/$shaB"))
        val stored = File(app.filesDir, "assets/$shaB.png")
        assertTrue(stored.readBytes().contentEquals(b))
        assertEquals(setOf(shaA, shaB), AssetStore.storedShas(app))
        assertEquals("image/png", provider.getType(uri("/$shaB.png")))
        // No temporary files are left behind.
        assertEquals(setOf("$shaA.jpg", "$shaB.png"), File(app.filesDir, "assets").list()!!.toSet())
    }

    @Test
    fun mismatchIsDeletedAndReported() {
        val claimed = Hashing.sha256Hex(image(9))
        contentWrite("/$claimed.webp", image(10))
        assertTrue(listing().isEmpty())
        assertTrue(File(app.filesDir, "assets").list().orEmpty().isEmpty())
        val error = Diagnostics.lastError(app)!!
        assertEquals(claimed, error.assetSha)
        assertTrue(error.message, error.message.startsWith("asset $claimed: sha256 mismatch"))

        // A correct re-push of the same asset clears the error.
        val good = image(9)
        contentWrite("/$claimed.webp", good)
        assertEquals(listOf(claimed to good.size.toLong()), listing())
        assertNull(Diagnostics.lastError(app))
    }

    @Test
    fun oversizedUploadIsRejected() {
        val big = ByteArray(8 * 1024 * 1024 + 1)
        val sha = Hashing.sha256Hex(big)
        contentWrite("/$sha.jpg", big)
        assertTrue(listing().isEmpty())
        assertEquals("asset $sha: larger than 8388608 bytes", Diagnostics.lastError(app)!!.message)
    }

    @Test
    fun repushUnderAnotherExtensionKeepsOneFile() {
        val a = image(3)
        val sha = Hashing.sha256Hex(a)
        contentWrite("/$sha.jpg", a)
        contentWrite("/$sha.png", a)
        assertEquals(listOf(sha to a.size.toLong()), listing())
        assertEquals(listOf("$sha.png"), File(app.filesDir, "assets").list()!!.toList())
    }

    @Test
    fun badPathsAndModesAreRefused() {
        val sha = Hashing.sha256Hex(image(4))
        val badPaths = listOf("/", "/x.jpg", "/$sha.gif", "/$sha", "/../$sha.jpg", "/..%2F$sha.jpg", "/a/$sha.jpg", "/$sha.jpg/")
        for (p in badPaths) {
            try {
                provider.openFile(uri(p), "w").close()
                fail("expected refusal for $p")
            } catch (e: FileNotFoundException) {
                assertTrue(e.message!!, e.message!!.startsWith("invalid asset path"))
            }
        }
        for (mode in listOf("r", "rw", "wa")) {
            try {
                provider.openFile(uri("/$sha.jpg"), mode).close()
                fail("expected refusal for mode $mode")
            } catch (e: FileNotFoundException) {
                assertTrue(e.message!!.startsWith("unsupported mode"))
            }
        }
        try {
            provider.query(uri("/../../shared_prefs"), null, null, null, null)
            fail("expected refusal")
        } catch (e: IllegalArgumentException) {
            // expected
        }
    }

    @Test
    fun deleteRemovesAnAsset() {
        val a = image(5)
        val sha = Hashing.sha256Hex(a)
        contentWrite("/$sha.jpg", a)
        assertEquals(1, provider.delete(uri("/$sha.jpg"), null, null))
        assertEquals(0, provider.delete(uri("/$sha.jpg"), null, null))
        assertTrue(listing().isEmpty())
        assertFalse(File(app.filesDir, "assets/$sha.jpg").exists())
    }

    @Test
    fun missingAssetsAreTheReferencedOnesNotStored() {
        val wallpaper = image(6)
        val shaW = Hashing.sha256Hex(wallpaper)
        val shaTile = "c".repeat(64)
        val json = """{"v":2,"home":{"wallpaper":{"asset":"$shaW","ext":"jpg"},"rows":[{"id":"r"}],
            "tiles":{"com.a.b":{"asset":"$shaTile","ext":"png"}}}}""".toByteArray()
        ConfigStore.save(app, ConfigParser.fromBytes(json) as ConfigResult.Ok, showWelcome = false)
        contentWrite("/$shaW.jpg", wallpaper)
        val referenced = ConfigStore.current(app).config.referencedAssets()
        assertEquals(setOf(shaTile), referenced - AssetStore.storedShas(app))
        // Referenced assets survive cleanup however old they are; the unreferenced one expires.
        val stray = image(7)
        val shaStray = Hashing.sha256Hex(stray)
        contentWrite("/$shaStray.png", stray)
        AssetStore.onConfigApplied(app, now = System.currentTimeMillis() - 48 * 3_600_000L)
        File(app.filesDir, "assets/$shaStray.png").setLastModified(System.currentTimeMillis() - 48 * 3_600_000L)
        AssetStore.resetForTests() // re-read the directory with the backdated time
        AssetStore.cleanup(app)
        assertEquals(setOf(shaW), AssetStore.storedShas(app))
    }
}
