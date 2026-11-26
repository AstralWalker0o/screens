package au.supercluster.screens.launcher.data

import android.content.Context
import android.content.SharedPreferences
import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.core.content.edit
import au.supercluster.screens.launcher.core.AssetIngest
import au.supercluster.screens.launcher.core.AssetLimits
import au.supercluster.screens.launcher.core.AssetName
import au.supercluster.screens.launcher.core.AssetPolicy
import au.supercluster.screens.launcher.core.IngestResult
import au.supercluster.screens.launcher.core.LastErrorPolicy
import au.supercluster.screens.launcher.core.StoredAsset
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Content-addressed image store in `filesDir/assets/` (docs/LAUNCHER-V2.md §1.1).
 *
 * Uploads arrive through [au.supercluster.screens.launcher.AssetProvider]: `content write` asks
 * for a writable descriptor and copies its stdin into it. We hand out the write end of a **pipe**
 * (not a file descriptor): from Android 14 the shell's SELinux domain may no longer write app
 * data files through a passed descriptor, while app-to-app pipes are allowed on every version.
 * A worker thread drains the pipe into a temporary file, hashing as it goes, and only when the
 * writer closes the pipe and the SHA-256 matches the requested name is the file renamed into
 * place. Anything else (mismatch, over 8 MiB, store full, timeout) deletes the temporary file
 * and is reported as STATUS `last_error`.
 */
object AssetStore {
    private const val TAG = "ScreensAssets"
    private const val DIR = "assets"
    private const val TEMP_PREFIX = ".incoming-"
    private const val PREFS = "launcher_assets"
    private const val KEY_CONFIG_APPLIED_AT = "config_applied_at"

    /** An upload that hasn't finished after this long is aborted. */
    private const val UPLOAD_TIMEOUT_SECONDS = 120L
    private const val MAX_CONCURRENT_UPLOADS = 4

    private val lock = Any()
    private val idleLock = Object()
    private var uploadsInFlight = 0

    @Volatile
    private var flow: MutableStateFlow<Map<String, StoredAsset>>? = null

    private val workers = Executors.newCachedThreadPool { r -> Thread(r, "screens-asset-upload").apply { isDaemon = true } }
    private val watchdog = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "screens-asset-watchdog").apply { isDaemon = true } }

    /** Stored assets by SHA-256. Always the same instance. */
    fun state(context: Context): StateFlow<Map<String, StoredAsset>> = ensure(context)

    fun list(context: Context): List<StoredAsset> = ensure(context).value.values.sortedBy { it.sha256 }

    fun storedShas(context: Context): Set<String> = ensure(context).value.keys

    /** The stored file for [sha256], or null when it isn't stored. */
    fun file(context: Context, sha256: String): File? {
        val asset = ensure(context).value[sha256] ?: return null
        return File(dir(context), "${asset.sha256}.${asset.ext.token}")
    }

    /**
     * Starts an upload of [name] and returns the descriptor the caller writes the bytes to.
     * Throws [FileNotFoundException] (what `content write` prints) when it can't start.
     */
    @Throws(FileNotFoundException::class)
    fun openUpload(context: Context, name: AssetName): ParcelFileDescriptor {
        val app = context.applicationContext
        reserve(app, name)
        val pipe = try {
            ParcelFileDescriptor.createPipe()
        } catch (e: IOException) {
            uploadFinished()
            throw FileNotFoundException("could not create pipe: ${e.message}")
        }
        val readEnd = pipe[0]
        val writeEnd = pipe[1]
        try {
            start(app, name, ParcelFileDescriptor.AutoCloseInputStream(readEnd))
        } catch (e: FileNotFoundException) {
            readEnd.close()
            writeEnd.close()
            throw e
        }
        // Binder hands the write end to the caller and closes our copy, so the worker sees EOF
        // as soon as the caller closes its end.
        return writeEnd
    }

    /**
     * Tests only: the same upload path as [openUpload], fed from [input] instead of a pipe
     * (Robolectric's `createPipe` is a temporary file, not a pipe, so it can't model a writer
     * that is slower than the reader).
     */
    @androidx.annotation.VisibleForTesting
    @Throws(FileNotFoundException::class)
    internal fun uploadForTests(context: Context, name: AssetName, input: InputStream) {
        val app = context.applicationContext
        reserve(app, name)
        start(app, name, input)
    }

    /** Checks there is room and a free upload slot, and takes the slot. */
    @Throws(FileNotFoundException::class)
    private fun reserve(app: Context, name: AssetName) {
        ensure(app)
        synchronized(lock) {
            val referenced = ConfigStore.current(app).config.referencedAssets()
            val stored = ensure(app).value.values
            if (AssetPolicy.selectEvictions(stored, referenced, name.sha256, 1, System.currentTimeMillis()) == null) {
                fail(app, name.sha256, "asset store full (${AssetLimits.MAX_TOTAL_BYTES} bytes)")
            }
        }
        synchronized(idleLock) {
            if (uploadsInFlight >= MAX_CONCURRENT_UPLOADS) throw FileNotFoundException("too many uploads in progress")
            uploadsInFlight++
        }
        dir(app).mkdirs()
    }

    /** Hands [input] to a worker; the slot taken by [reserve] is released when it finishes. */
    @Throws(FileNotFoundException::class)
    private fun start(app: Context, name: AssetName, input: InputStream) {
        try {
            workers.execute { receive(app, name, input) }
        } catch (e: RuntimeException) {
            uploadFinished()
            throw FileNotFoundException("could not start upload")
        }
    }

    /** Waits up to [timeoutMillis] for uploads in progress to finish. True when none is left. */
    fun awaitIdle(timeoutMillis: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMillis
        synchronized(idleLock) {
            while (uploadsInFlight > 0) {
                val left = deadline - System.currentTimeMillis()
                if (left <= 0) return false
                idleLock.wait(left)
            }
        }
        return true
    }

    /** Deletes the stored asset [sha256]. True when something was deleted. */
    fun delete(context: Context, sha256: String): Boolean {
        val app = context.applicationContext
        synchronized(lock) {
            val asset = ensure(app).value[sha256] ?: return false
            File(dir(app), "${asset.sha256}.${asset.ext.token}").delete()
            ensure(app).value = ensure(app).value - sha256
            return true
        }
    }

    /** Records that a config was applied: unreferenced assets now get 24 h before cleanup. */
    fun onConfigApplied(context: Context, now: Long = System.currentTimeMillis()) {
        prefs(context).edit(commit = true) { putLong(KEY_CONFIG_APPLIED_AT, now) }
        cleanup(context, now)
    }

    /** Deletes unreferenced assets whose 24 h grace period is over. Cheap; called often. */
    fun cleanup(context: Context, now: Long = System.currentTimeMillis()) {
        val app = context.applicationContext
        synchronized(lock) {
            val current = ensure(app).value
            if (current.isEmpty()) return
            val referenced = ConfigStore.current(app).config.referencedAssets()
            var appliedAt: Long? = prefs(app).getLong(KEY_CONFIG_APPLIED_AT, -1L).takeIf { it >= 0 }
            if (now >= AssetLimits.MIN_VALID_WALL_CLOCK) {
                // Timestamps taken before the clock was set: restart their grace period now.
                if (appliedAt != null && appliedAt < AssetLimits.MIN_VALID_WALL_CLOCK) {
                    appliedAt = now
                    prefs(app).edit(commit = true) { putLong(KEY_CONFIG_APPLIED_AT, now) }
                }
                current.values.filter { it.writtenAt < AssetLimits.MIN_VALID_WALL_CLOCK }.forEach { restamp(app, it, now) }
            }
            val expired = AssetPolicy.selectExpired(ensure(app).value.values, referenced, appliedAt, now)
            if (expired.isEmpty()) return
            for (asset in expired) File(dir(app), "${asset.sha256}.${asset.ext.token}").delete()
            ensure(app).value = ensure(app).value - expired.map { it.sha256 }.toSet()
            Log.i(TAG, "cleanup deleted ${expired.size} unreferenced asset(s)")
        }
    }

    private fun receive(app: Context, name: AssetName, input: InputStream) {
        // Closing the stream from another thread wakes a read blocked on a writer that never finishes.
        val timeout = watchdog.schedule({ runCatching { input.close() } }, UPLOAD_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        val temp = File(dir(app), TEMP_PREFIX + UUID.randomUUID())
        try {
            val result = try {
                FileOutputStream(temp).use { out ->
                    AssetIngest.copyVerified(input, out, name.sha256).also {
                        if (it is IngestResult.Ok) out.fd.sync()
                    }
                }
            } catch (e: IOException) {
                temp.delete()
                record(app, name.sha256, if (timeout.isDone) "upload timed out" else "upload failed (${e.javaClass.simpleName})")
                return
            }
            when (result) {
                is IngestResult.Ok -> commit(app, name, temp, result.bytes)
                is IngestResult.TooLarge -> {
                    temp.delete()
                    record(app, name.sha256, "larger than ${result.limit} bytes")
                }
                is IngestResult.Mismatch -> {
                    temp.delete()
                    record(app, name.sha256, "sha256 mismatch (received ${result.bytes} bytes with sha256 ${result.actual})")
                }
            }
        } catch (e: RuntimeException) {
            temp.delete()
            Log.w(TAG, "upload failed", e)
            record(app, name.sha256, "upload failed (${e.javaClass.simpleName})")
        } finally {
            timeout.cancel(false)
            runCatching { input.close() }
            uploadFinished()
        }
    }

    private fun commit(app: Context, name: AssetName, temp: File, bytes: Long) {
        synchronized(lock) {
            val now = System.currentTimeMillis()
            val referenced = ConfigStore.current(app).config.referencedAssets()
            val current = ensure(app).value
            val evict = AssetPolicy.selectEvictions(current.values, referenced, name.sha256, bytes, now)
            if (evict == null) {
                temp.delete()
                record(app, name.sha256, "asset store full (${AssetLimits.MAX_TOTAL_BYTES} bytes)")
                return
            }
            for (asset in evict) File(dir(app), "${asset.sha256}.${asset.ext.token}").delete()
            // One file per SHA: drop a copy stored under another extension.
            current[name.sha256]?.takeIf { it.ext != name.ext }?.let { File(dir(app), "${it.sha256}.${it.ext.token}").delete() }
            val target = File(dir(app), name.fileName)
            if (!temp.renameTo(target)) {
                temp.delete()
                record(app, name.sha256, "could not store file")
                return
            }
            target.setLastModified(now)
            val stored = StoredAsset(name.sha256, name.ext, bytes, target.lastModified().takeIf { it > 0 } ?: now)
            ensure(app).value = current - evict.map { it.sha256 }.toSet() + (name.sha256 to stored)
            if (evict.isNotEmpty()) Log.i(TAG, "evicted ${evict.size} unreferenced asset(s) to make room")
            Log.i(TAG, "stored asset ${name.fileName} ($bytes bytes)")
        }
        Diagnostics.update(app) { LastErrorPolicy.afterAssetStored(it, name.sha256) }
    }

    /** Reports that a stored asset couldn't be decoded as an image. */
    fun reportUndecodable(context: Context, sha256: String) {
        record(context.applicationContext, sha256, "cannot decode image")
    }

    private fun record(app: Context, sha256: String, message: String) {
        Log.w(TAG, "asset $sha256 rejected: $message")
        Diagnostics.record(app, LastErrorPolicy.assetRejected(sha256, message))
    }

    @Throws(FileNotFoundException::class)
    private fun fail(app: Context, sha256: String, message: String): Nothing {
        record(app, sha256, message)
        throw FileNotFoundException(message)
    }

    private fun uploadFinished() {
        synchronized(idleLock) {
            uploadsInFlight--
            idleLock.notifyAll()
        }
    }

    private fun restamp(app: Context, asset: StoredAsset, now: Long) {
        val file = File(dir(app), "${asset.sha256}.${asset.ext.token}")
        file.setLastModified(now)
        ensure(app).value = ensure(app).value + (asset.sha256 to asset.copy(writtenAt = now))
    }

    private fun ensure(context: Context): MutableStateFlow<Map<String, StoredAsset>> {
        flow?.let { return it }
        synchronized(lock) {
            flow?.let { return it }
            return MutableStateFlow(scan(context.applicationContext)).also { flow = it }
        }
    }

    /** Reads the directory once per process: drops leftovers of interrupted uploads and stray files. */
    private fun scan(app: Context): Map<String, StoredAsset> {
        val files = dir(app).listFiles() ?: return emptyMap()
        val out = HashMap<String, StoredAsset>()
        for (f in files) {
            val name = AssetName.parse(f.name)
            if (!f.isFile || name == null || name.fileName != f.name) {
                f.delete() // temporary files from a previous process, or anything we didn't write
                continue
            }
            val asset = StoredAsset(name.sha256, name.ext, f.length(), f.lastModified())
            val existing = out[name.sha256]
            if (existing == null || existing.writtenAt < asset.writtenAt) {
                existing?.let { File(dir(app), "${it.sha256}.${it.ext.token}").delete() }
                out[name.sha256] = asset
            } else {
                f.delete()
            }
        }
        return out
    }

    /** Tests only: forget the in-memory index (each Robolectric test has a fresh app). */
    @androidx.annotation.VisibleForTesting
    internal fun resetForTests() {
        awaitIdle(5_000)
        synchronized(lock) { flow = null }
    }

    private fun dir(context: Context) = File(context.applicationContext.filesDir, DIR)

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
