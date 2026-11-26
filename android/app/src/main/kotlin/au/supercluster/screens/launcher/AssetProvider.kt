package au.supercluster.screens.launcher

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import au.supercluster.screens.launcher.core.AssetName
import au.supercluster.screens.launcher.data.AssetStore
import java.io.FileNotFoundException

/**
 * Image assets for the v2 home screen, pushed by the Screens gateway over adb
 * (docs/LAUNCHER-V2.md §1.1). Authority `au.supercluster.screens.launcher.assets`, exported, with
 * read and write permission `android.permission.DUMP`, so only the adb shell or the system can
 * use it.
 *
 * ```sh
 * content write --uri content://au.supercluster.screens.launcher.assets/<sha256>.<jpg|png|webp> < file
 * content query --uri content://au.supercluster.screens.launcher.assets/
 * # Row: 0 sha256=<hex>, bytes=<n>
 * content delete --uri content://au.supercluster.screens.launcher.assets/<sha256>.<ext>
 * ```
 */
class AssetProvider : ContentProvider() {

    // Nothing to do up front: the store is read lazily on first use, off the main thread.
    override fun onCreate(): Boolean = true

    @Throws(FileNotFoundException::class)
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val ctx = context ?: throw FileNotFoundException("provider not ready")
        val name = AssetName.parseUriPath(uri.encodedPath)
            ?: throw FileNotFoundException("invalid asset path: expected /<64 hex sha256>.<jpg|png|webp>")
        if (mode != "w" && mode != "wt") {
            throw FileNotFoundException("unsupported mode \"$mode\": assets are write-only (content write)")
        }
        return AssetStore.openUpload(ctx, name)
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        val ctx = context ?: throw IllegalStateException("provider not ready")
        val only = shaFilter(uri)
        // `content write` returns as soon as the bytes are in the pipe; let a just-finished upload
        // land so that a query right after it sees the result.
        AssetStore.awaitIdle(QUERY_WAIT_MILLIS)
        AssetStore.cleanup(ctx)
        val columns = projection?.filter { it in COLUMNS }?.takeIf { it.isNotEmpty() }?.toTypedArray() ?: COLUMNS
        val cursor = MatrixCursor(columns)
        for (asset in AssetStore.list(ctx)) {
            if (only != null && asset.sha256 != only) continue
            cursor.addRow(columns.map { if (it == COLUMN_SHA256) asset.sha256 else asset.bytes })
        }
        return cursor
    }

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int {
        val ctx = context ?: throw IllegalStateException("provider not ready")
        val sha = shaFilter(uri) ?: throw IllegalArgumentException("delete needs /<sha256>.<ext> or /<sha256>")
        AssetStore.awaitIdle(QUERY_WAIT_MILLIS)
        return if (AssetStore.delete(ctx, sha)) 1 else 0
    }

    override fun getType(uri: Uri): String? = AssetName.parseUriPath(uri.encodedPath)?.ext?.mimeType

    override fun insert(uri: Uri, values: ContentValues?): Uri? =
        throw UnsupportedOperationException("use content write --uri …/<sha256>.<ext>")

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int =
        throw UnsupportedOperationException("assets are immutable")

    /** Null for the whole store (`/` or no path); else the SHA named by `/<sha>.<ext>` or `/<sha>`. */
    private fun shaFilter(uri: Uri): String? {
        val path = uri.encodedPath
        if (path.isNullOrEmpty() || path == "/") return null
        AssetName.parseUriPath(path)?.let { return it.sha256 }
        val bare = path.removePrefix("/")
        if (AssetName.isSha256(bare)) return bare.lowercase()
        throw IllegalArgumentException("invalid asset path: expected / or /<64 hex sha256>[.<jpg|png|webp>]")
    }

    private companion object {
        const val COLUMN_SHA256 = "sha256"
        const val COLUMN_BYTES = "bytes"
        val COLUMNS = arrayOf(COLUMN_SHA256, COLUMN_BYTES)
        const val QUERY_WAIT_MILLIS = 10_000L
    }
}
