package au.supercluster.screens.launcher.data

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.drawable.Drawable
import android.util.Log
import android.util.LruCache
import androidx.compose.ui.graphics.asImageBitmap
import androidx.core.graphics.drawable.toBitmap
import au.supercluster.screens.launcher.ui.Art
import au.supercluster.screens.launcher.ui.ArtKind
import au.supercluster.screens.launcher.ui.ArtRequest
import au.supercluster.screens.launcher.ui.ArtSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.withContext
import java.io.File
import java.util.Collections

/**
 * Loads app banners and icons from PackageManager and image assets from [AssetStore], decoded
 * once at the exact pixel size they are drawn at, and keeps them in a byte-bounded LRU cache
 * shared by the whole process.
 */
class ArtLoader private constructor(context: Context) : ArtSource {
    private val app = context.applicationContext
    private val pm: PackageManager = app.packageManager

    private val cache = object : LruCache<String, Art>(cacheBytes()) {
        override fun sizeOf(key: String, value: Art): Int = value.bitmap?.let { it.width * it.height * 4 } ?: 64
    }

    /** SHAs already reported as undecodable, so `last_error` isn't rewritten on every scroll. */
    private val reportedBad = Collections.synchronizedSet(HashSet<String>())

    override fun peek(request: ArtRequest): Art? = cache.get(request.key)

    override suspend fun load(request: ArtRequest): Art {
        cache.get(request.key)?.let { return it }
        return withContext(decodeDispatcher) {
            cache.get(request.key) ?: run {
                val art = try {
                    when (request) {
                        is ArtRequest.AppCard -> loadCard(request)
                        is ArtRequest.Image -> loadImage(request)
                    }
                } catch (e: OutOfMemoryError) {
                    cache.evictAll()
                    Art.None
                } catch (e: RuntimeException) {
                    Log.w(TAG, "art load failed for ${request.key}", e)
                    Art.None
                }
                cache.put(request.key, art)
                art
            }
        }
    }

    private fun loadCard(r: ArtRequest.AppCard): Art {
        r.assetSha?.let { sha ->
            decodeAsset(sha, r.widthPx, r.heightPx)?.let { return Art(it.asImageBitmap(), ArtKind.ASSET) }
        }
        val component = ComponentName(r.app.packageName, r.app.activityName)
        if (r.preferBanner) {
            val banner = runCatching { pm.getActivityBanner(component) }.getOrNull()
                ?: runCatching { pm.getApplicationBanner(r.app.packageName) }.getOrNull()
            banner?.let { render(it, r.widthPx, r.heightPx) }?.let { return Art(it.asImageBitmap(), ArtKind.BANNER) }
        }
        val icon = runCatching { pm.getActivityIcon(component) }.getOrNull()
            ?: runCatching { pm.getApplicationIcon(r.app.packageName) }.getOrNull()
        return icon?.let { render(it, r.iconPx, r.iconPx) }?.let { Art(it.asImageBitmap(), ArtKind.ICON) } ?: Art.None
    }

    private fun loadImage(r: ArtRequest.Image): Art =
        decodeAsset(r.sha256, r.widthPx, r.heightPx)?.let { Art(it.asImageBitmap(), ArtKind.ASSET) } ?: Art.None

    private fun decodeAsset(sha: String, w: Int, h: Int): Bitmap? {
        val file = AssetStore.file(app, sha) ?: return null
        val bitmap = decodeCover(file, w, h)
        if (bitmap == null && reportedBad.add(sha)) AssetStore.reportUndecodable(app, sha)
        return bitmap
    }

    private fun render(d: Drawable, w: Int, h: Int): Bitmap? =
        runCatching { d.toBitmap(w.coerceAtLeast(1), h.coerceAtLeast(1), Bitmap.Config.ARGB_8888) }.getOrNull()

    companion object {
        private const val TAG = "ScreensArt"

        @Volatile
        private var instance: ArtLoader? = null

        fun get(context: Context): ArtLoader =
            instance ?: synchronized(this) { instance ?: ArtLoader(context).also { instance = it } }

        @OptIn(ExperimentalCoroutinesApi::class)
        private val decodeDispatcher = Dispatchers.IO.limitedParallelism(3)

        /** An eighth of the heap, capped at 64 MiB: about 60 banners plus a 1080p wallpaper. */
        private fun cacheBytes(): Int = (Runtime.getRuntime().maxMemory() / 8).coerceAtMost(64L * 1024 * 1024).toInt()

        /**
         * Decodes [file] centre-cropped to exactly [w] x [h]: subsampled while decoding (so a large
         * JPEG never sits in memory at full size), then cropped and scaled once.
         */
        fun decodeCover(file: File, w: Int, h: Int): Bitmap? {
            if (w <= 0 || h <= 0) return null
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.path, bounds)
            val ow = bounds.outWidth
            val oh = bounds.outHeight
            if (ow <= 0 || oh <= 0) return null
            // The largest power-of-two subsample that still covers w x h after cropping.
            val cover = maxOf(w.toFloat() / ow, h.toFloat() / oh)
            var sample = 1
            while (cover * sample * 2 <= 1f) sample *= 2
            val src = BitmapFactory.decodeFile(
                file.path,
                BitmapFactory.Options().apply {
                    inSampleSize = sample
                    inPreferredConfig = Bitmap.Config.ARGB_8888
                },
            ) ?: return null
            val scale = maxOf(w.toFloat() / src.width, h.toFloat() / src.height)
            val cropW = (w / scale).toInt().coerceIn(1, src.width)
            val cropH = (h / scale).toInt().coerceIn(1, src.height)
            val left = (src.width - cropW) / 2
            val top = (src.height - cropH) / 2
            val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            Canvas(out).drawBitmap(
                src,
                Rect(left, top, left + cropW, top + cropH),
                Rect(0, 0, w, h),
                Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG),
            )
            if (out !== src) src.recycle()
            out.prepareToDraw()
            return out
        }
    }
}
