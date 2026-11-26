package au.supercluster.screens.launcher.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream

class AssetsTest {
    private val sha = "0123456789abcdef".repeat(4)

    // --- path validation -----------------------------------------------------------------

    @Test
    fun acceptsExactlyShaDotExt() {
        assertEquals(AssetName(sha, AssetExt.JPG), AssetName.parseUriPath("/$sha.jpg"))
        assertEquals(AssetName(sha, AssetExt.PNG), AssetName.parseUriPath("/$sha.png"))
        assertEquals(AssetName(sha, AssetExt.WEBP), AssetName.parseUriPath("/$sha.webp"))
        assertEquals("$sha.webp", AssetName.parseUriPath("/$sha.webp")!!.fileName)
        // Hex digits and the extension may be upper case; both are normalised.
        assertEquals(AssetName(sha, AssetExt.JPG), AssetName.parseUriPath("/${sha.uppercase()}.JPG"))
        assertEquals(AssetName(sha, AssetExt.PNG), AssetName.parse("$sha.png"))
    }

    @Test
    fun rejectsEverythingElseIncludingTraversal() {
        val bad = listOf(
            null,
            "",
            "/",
            "$sha.jpg", // no leading slash
            "/$sha", // no extension
            "/$sha.jpeg",
            "/$sha.gif",
            "/$sha.jpg.png",
            "/$sha..jpg",
            "/${sha.dropLast(1)}.jpg", // 63 hex
            "/${sha}0.jpg", // 65 hex
            "/${sha.replaceFirst('0', 'g')}.jpg",
            "//$sha.jpg",
            "/$sha.jpg/",
            "/a/$sha.jpg",
            "/../$sha.jpg",
            "/..%2F$sha.jpg",
            "/%2e%2e/$sha.jpg",
            "/$sha%2Ejpg",
            "/$sha.jpg%00.png",
            "/$sha.jpg?x=1",
            "/ $sha.jpg",
            "/$sha.jpg ",
            "/.incoming-$sha.jpg",
            "/../../shared_prefs/launcher_state.xml",
            "/../config.json",
        )
        bad.forEach { assertNull("should reject: $it", AssetName.parseUriPath(it)) }
    }

    @Test
    fun bareShaHelper() {
        assertTrue(AssetName.isSha256(sha))
        assertTrue(AssetName.isSha256(sha.uppercase()))
        assertFalse(AssetName.isSha256(sha.drop(1)))
        assertFalse(AssetName.isSha256(null))
    }

    // --- streaming ingest --------------------------------------------------------------------

    @Test
    fun ingestAcceptsMatchingSha() {
        val data = ByteArray(200_000) { (it * 31).toByte() }
        val out = ByteArrayOutputStream()
        val r = AssetIngest.copyVerified(ByteArrayInputStream(data), out, Hashing.sha256Hex(data).uppercase())
        assertEquals(IngestResult.Ok(Hashing.sha256Hex(data), data.size.toLong()), r)
        assertTrue(out.toByteArray().contentEquals(data))
    }

    @Test
    fun ingestReportsMismatchWithWhatArrived() {
        val data = "not the expected image".toByteArray()
        val r = AssetIngest.copyVerified(ByteArrayInputStream(data), ByteArrayOutputStream(), sha)
        assertEquals(IngestResult.Mismatch(sha, Hashing.sha256Hex(data), data.size.toLong()), r)
        // A truncated upload (writer died half way) is just a mismatch too.
        val empty = AssetIngest.copyVerified(ByteArrayInputStream(ByteArray(0)), ByteArrayOutputStream(), sha)
        assertTrue(empty is IngestResult.Mismatch)
    }

    @Test
    fun ingestStopsReadingOnceOverTheLimit() {
        val limit = 1000L
        val exact = ByteArray(limit.toInt()) { 7 }
        assertTrue(AssetIngest.copyVerified(ByteArrayInputStream(exact), ByteArrayOutputStream(), Hashing.sha256Hex(exact), limit) is IngestResult.Ok)

        // An endless stream: the copy must give up instead of reading (and storing) forever.
        var served = 0L
        val endless = object : InputStream() {
            override fun read(): Int = 1
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                val n = minOf(len, 100)
                served += n
                return n
            }
        }
        val out = ByteArrayOutputStream()
        assertEquals(IngestResult.TooLarge(limit), AssetIngest.copyVerified(endless, out, sha, limit))
        assertTrue(out.size() <= limit)
        assertTrue(served <= limit + 100)
    }

    @Test
    fun defaultLimitsMatchTheContract() {
        assertEquals(8L * 1024 * 1024, AssetLimits.MAX_ASSET_BYTES)
        assertEquals(64L * 1024 * 1024, AssetLimits.MAX_TOTAL_BYTES)
        assertEquals(24L * 3600 * 1000, AssetLimits.UNREFERENCED_GRACE_MILLIS)
    }

    // --- cleanup -------------------------------------------------------------------------------

    private val hour = 3_600_000L
    private val now = 1_790_000_000_000L // late 2026
    private fun asset(id: Char, writtenAgoHours: Long, bytes: Long = 1000) =
        StoredAsset(id.toString().repeat(64), AssetExt.JPG, bytes, now - writtenAgoHours * hour)

    @Test
    fun cleanupDeletesOnlyUnreferencedAssetsPastBothGracePeriods() {
        val referencedOld = asset('a', 100)
        val unreferencedOld = asset('b', 100)
        val unreferencedFresh = asset('c', 2) // pushed recently, e.g. for a config still to come
        val stored = listOf(referencedOld, unreferencedOld, unreferencedFresh)
        val referenced = setOf(referencedOld.sha256)

        // Config applied 25 h ago: only the old unreferenced asset goes.
        assertEquals(listOf(unreferencedOld), AssetPolicy.selectExpired(stored, referenced, now - 25 * hour, now))
        // Config applied 23 h ago: nothing yet (24 h after a new config).
        assertTrue(AssetPolicy.selectExpired(stored, referenced, now - 23 * hour, now).isEmpty())
        // Exactly 24 h counts as expired.
        assertEquals(listOf(unreferencedOld), AssetPolicy.selectExpired(stored, referenced, now - 24 * hour, now))
        // Never configured: assets expire 24 h after they were written.
        assertEquals(listOf(unreferencedOld), AssetPolicy.selectExpired(stored, referenced, null, now))
    }

    @Test
    fun cleanupNeverRunsOnAnUnsetClock() {
        val stored = listOf(asset('b', 100))
        // The box thinks it's 1970 (no network time yet).
        assertTrue(AssetPolicy.selectExpired(stored, emptySet(), null, 5 * hour).isEmpty())
        // The config was applied while the clock was unset.
        assertTrue(AssetPolicy.selectExpired(stored, emptySet(), 10 * hour, now).isEmpty())
        // The asset was written while the clock was unset.
        val writtenIn1970 = StoredAsset("d".repeat(64), AssetExt.PNG, 10, 3 * hour)
        assertTrue(AssetPolicy.selectExpired(listOf(writtenIn1970), emptySet(), now - 48 * hour, now).isEmpty())
    }

    // --- total-size eviction ----------------------------------------------------------------------

    @Test
    fun evictionIsNotNeededUnderTheLimit() {
        val stored = listOf(asset('a', 10, 10_000_000), asset('b', 10, 10_000_000))
        assertEquals(emptyList<StoredAsset>(), AssetPolicy.selectEvictions(stored, emptySet(), sha, 8_000_000, now))
    }

    @Test
    fun evictionRemovesOldestUnreferencedUnprotectedAssetsFirst() {
        val mb = 1024L * 1024
        val referenced = asset('a', 100, 30 * mb)
        val oldest = asset('b', 50, 10 * mb)
        val older = asset('c', 20, 10 * mb)
        val recent = asset('e', 0, 10 * mb) // protected: written in the last hour
        val stored = listOf(referenced, older, oldest, recent)
        // 60 MB stored + 8 MB incoming = 68 MB > 64 MB: evicting the oldest (10 MB) is enough.
        assertEquals(listOf(oldest), AssetPolicy.selectEvictions(stored, setOf(referenced.sha256), sha, 8 * mb, now))
        // 60 + 8 MB with only protected or referenced assets left over: can't fit.
        assertNull(AssetPolicy.selectEvictions(listOf(referenced, recent, asset('f', 0, 20 * mb)), setOf(referenced.sha256), sha, 8 * mb, now))
    }

    @Test
    fun replacingTheSameShaDoesNotCountTwice() {
        val mb = 1024L * 1024
        val same = StoredAsset(sha, AssetExt.JPG, 8 * mb, now - hour)
        val other = asset('a', 100, 56 * mb)
        assertEquals(emptyList<StoredAsset>(), AssetPolicy.selectEvictions(listOf(same, other), setOf(other.sha256, sha), sha, 8 * mb, now))
    }

    @Test
    fun anAssetLargerThanTheWholeStoreNeverFits() {
        assertNull(AssetPolicy.selectEvictions(emptyList(), emptySet(), sha, AssetLimits.MAX_TOTAL_BYTES + 1, now))
    }

    // --- last_error ---------------------------------------------------------------------------------

    @Test
    fun lastErrorLifecycle() {
        val configError = LastErrorPolicy.configRejected("home.rows: expected 1 to 12 rows")
        assertEquals("config: home.rows: expected 1 to 12 rows", configError.message)
        assertNull(configError.assetSha)
        // A good config clears a config error.
        assertNull(LastErrorPolicy.afterConfigApplied(configError, emptySet(), emptySet()))

        val assetError = LastErrorPolicy.assetRejected(sha, "sha256 mismatch")
        assertEquals("asset $sha: sha256 mismatch", assetError.message)
        // Still relevant: the new config references the asset and it's still missing.
        assertEquals(assetError, LastErrorPolicy.afterConfigApplied(assetError, setOf(sha), emptySet()))
        // Not relevant any more: not referenced, or present after all.
        assertNull(LastErrorPolicy.afterConfigApplied(assetError, emptySet(), emptySet()))
        assertNull(LastErrorPolicy.afterConfigApplied(assetError, setOf(sha), setOf(sha)))
        // A successful write of that asset clears it; of another asset doesn't.
        assertNull(LastErrorPolicy.afterAssetStored(assetError, sha))
        assertEquals(assetError, LastErrorPolicy.afterAssetStored(assetError, "f".repeat(64)))
        assertEquals(configError, LastErrorPolicy.afterAssetStored(configError, sha))
    }
}
