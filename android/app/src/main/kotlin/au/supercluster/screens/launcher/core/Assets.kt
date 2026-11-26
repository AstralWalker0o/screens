package au.supercluster.screens.launcher.core

import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest

/**
 * Pure logic behind the assets provider (docs/LAUNCHER-V2.md §1.1). Android-free so it runs in
 * JVM unit tests; `data/AssetStore` does the file and pipe plumbing.
 */
object AssetLimits {
    /** Per-asset limit: 8 MiB. */
    const val MAX_ASSET_BYTES: Long = 8L * 1024 * 1024

    /** Total limit for all stored assets: 64 MiB. */
    const val MAX_TOTAL_BYTES: Long = 64L * 1024 * 1024

    /** Unreferenced assets are kept this long after the last config apply and after their own write. */
    const val UNREFERENCED_GRACE_MILLIS: Long = 24L * 60 * 60 * 1000

    /** When the store is full, unreferenced assets written within this window are never evicted. */
    const val EVICTION_PROTECT_MILLIS: Long = 60L * 60 * 1000

    /**
     * Timestamps before this (2021-01-01 UTC) are treated as "clock not set yet": a box that boots
     * without network can briefly think it is 1970, and that must not make assets look ancient.
     */
    const val MIN_VALID_WALL_CLOCK: Long = 1_609_459_200_000L
}

/** A validated asset file name: `<64 lower-case hex>.<jpg|png|webp>`. */
data class AssetName(val sha256: String, val ext: AssetExt) {
    val fileName: String get() = "$sha256.${ext.token}"

    companion object {
        private val NAME = Regex("^([0-9a-fA-F]{64})\\.([A-Za-z]{3,4})$")
        private val SHA = Regex("^[0-9a-fA-F]{64}$")

        /**
         * Parses a single file name such as `ab12….jpg`. Hex digits and the extension may be in any
         * case and are normalised to lower case. Returns null for anything else.
         */
        fun parse(name: String?): AssetName? {
            if (name == null) return null
            val m = NAME.matchEntire(name) ?: return null
            val ext = AssetExt.fromToken(m.groupValues[2].lowercase()) ?: return null
            return AssetName(m.groupValues[1].lowercase(), ext)
        }

        /**
         * Parses a provider URI's *encoded* path. It must be exactly `/<name>`: one segment, no
         * percent-encoding, no `.`/`..`, no extra slashes. Validating the encoded form means no
         * decoding trick (`%2F`, `%2e%2e`) can reach the file system.
         */
        fun parseUriPath(encodedPath: String?): AssetName? {
            if (encodedPath == null || !encodedPath.startsWith("/")) return null
            return parse(encodedPath.substring(1))
        }

        /** True for a bare 64-hex SHA-256 (any case). */
        fun isSha256(s: String?): Boolean = s != null && SHA.matches(s)
    }
}

/** One stored asset, as the store sees it. */
data class StoredAsset(
    val sha256: String,
    val ext: AssetExt,
    val bytes: Long,
    /** Wall-clock time the asset was (last) written. */
    val writtenAt: Long,
)

/** Outcome of streaming one upload into a temporary file. */
sealed class IngestResult {
    data class Ok(val sha256: String, val bytes: Long) : IngestResult()
    data class TooLarge(val limit: Long) : IngestResult()
    data class Mismatch(val expected: String, val actual: String, val bytes: Long) : IngestResult()
}

object AssetIngest {
    /**
     * Copies [input] to [output] while hashing, stopping as soon as more than [maxBytes] arrive
     * (the rest of the input is not read). The caller deletes the output on anything but [IngestResult.Ok].
     */
    @Throws(IOException::class)
    fun copyVerified(input: InputStream, output: OutputStream, expectedSha256: String, maxBytes: Long = AssetLimits.MAX_ASSET_BYTES): IngestResult {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            if (n == 0) continue
            total += n
            if (total > maxBytes) return IngestResult.TooLarge(maxBytes)
            digest.update(buffer, 0, n)
            output.write(buffer, 0, n)
        }
        output.flush()
        val actual = Hashing.toHex(digest.digest())
        return if (actual == expectedSha256.lowercase()) {
            IngestResult.Ok(actual, total)
        } else {
            IngestResult.Mismatch(expectedSha256.lowercase(), actual, total)
        }
    }
}

object AssetPolicy {
    private fun valid(t: Long?): Long? = t?.takeIf { it >= AssetLimits.MIN_VALID_WALL_CLOCK }

    /**
     * Assets to delete in routine cleanup: not referenced by the current config, and at least
     * [AssetLimits.UNREFERENCED_GRACE_MILLIS] past both the last config apply and their own write.
     * With an unset clock (see [AssetLimits.MIN_VALID_WALL_CLOCK]) nothing is deleted.
     */
    fun selectExpired(
        stored: Collection<StoredAsset>,
        referenced: Set<String>,
        configAppliedAt: Long?,
        now: Long,
        grace: Long = AssetLimits.UNREFERENCED_GRACE_MILLIS,
    ): List<StoredAsset> {
        if (valid(now) == null) return emptyList()
        val appliedAt = configAppliedAt?.let { valid(it) ?: return emptyList() } ?: 0L
        return stored.filter { asset ->
            val written = valid(asset.writtenAt) ?: return@filter false
            asset.sha256 !in referenced && now - appliedAt >= grace && now - written >= grace
        }
    }

    /**
     * Makes room for an incoming asset of [incomingBytes] (SHA [incomingSha]). Returns the assets
     * to evict first, oldest first, or null when it can't fit even after evicting everything that
     * may go. Only unreferenced assets written more than [AssetLimits.EVICTION_PROTECT_MILLIS] ago
     * may be evicted, so assets pushed ahead of a config can't push each other out. An existing
     * copy of the same SHA is replaced, so it doesn't count toward the total.
     */
    fun selectEvictions(
        stored: Collection<StoredAsset>,
        referenced: Set<String>,
        incomingSha: String,
        incomingBytes: Long,
        now: Long,
        maxTotal: Long = AssetLimits.MAX_TOTAL_BYTES,
        protect: Long = AssetLimits.EVICTION_PROTECT_MILLIS,
    ): List<StoredAsset>? {
        if (incomingBytes > maxTotal) return null
        val others = stored.filter { it.sha256 != incomingSha }
        var total = others.sumOf { it.bytes } + incomingBytes
        if (total <= maxTotal) return emptyList()
        val evictable = others
            .filter { it.sha256 !in referenced && valid(it.writtenAt)?.let { w -> now - w >= protect } == true }
            .sortedWith(compareBy<StoredAsset> { it.writtenAt }.thenBy { it.sha256 })
        val out = ArrayList<StoredAsset>()
        for (asset in evictable) {
            if (total <= maxTotal) break
            out.add(asset)
            total -= asset.bytes
        }
        return if (total <= maxTotal) out else null
    }
}

/** The `last_error` reported in STATUS, plus the asset it is about (if any). */
data class LastError(val message: String, val assetSha: String? = null)

/**
 * When `last_error` is set and cleared (docs/LAUNCHER-V2.md §1.3):
 * set by a rejected CONFIG broadcast, a rejected asset write or an undecodable asset; cleared by
 * a CONFIG broadcast that applies (unless the error is about an asset that config references and
 * that is still missing), and by a successful write of the asset the error is about.
 */
object LastErrorPolicy {
    fun configRejected(message: String) = LastError("config: $message")

    fun assetRejected(sha256: String, message: String) = LastError("asset $sha256: $message", sha256)

    fun afterConfigApplied(current: LastError?, referenced: Set<String>, stored: Set<String>): LastError? {
        val sha = current?.assetSha ?: return null
        return if (sha in referenced && sha !in stored) current else null
    }

    fun afterAssetStored(current: LastError?, sha256: String): LastError? =
        if (current?.assetSha == sha256) null else current
}
