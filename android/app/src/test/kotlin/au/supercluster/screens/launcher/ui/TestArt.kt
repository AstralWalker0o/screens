package au.supercluster.screens.launcher.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import androidx.compose.ui.graphics.asImageBitmap
import kotlin.random.Random

/**
 * Artwork for screenshot tests, drawn procedurally so the repo holds no third-party images:
 * a landscape wallpaper (sky, clouds, mountains, lake) and plain coloured placeholder banners
 * and icons carrying each app's name.
 */
object TestArt {
    fun wallpaper(w: Int = 1920, h: Int = 1080): Bitmap {
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val p = Paint(Paint.ANTI_ALIAS_FLAG)
        val horizon = h * 0.64f

        // Sky.
        p.shader = LinearGradient(0f, 0f, 0f, horizon, intArrayOf(0xFF2F5E93.toInt(), 0xFF6F98C2.toInt(), 0xFFC9D8E6.toInt()), floatArrayOf(0f, 0.55f, 1f), Shader.TileMode.CLAMP)
        c.drawRect(0f, 0f, w.toFloat(), horizon, p)

        // Clouds: clusters of soft radial blobs.
        val rnd = Random(7)
        repeat(9) { cluster ->
            val cx = w * (0.05f + cluster * 0.115f) + rnd.nextFloat() * 80f
            val cy = h * (0.10f + rnd.nextFloat() * 0.30f)
            repeat(7) {
                val r = h * (0.05f + rnd.nextFloat() * 0.07f)
                val x = cx + (rnd.nextFloat() - 0.5f) * r * 3.5f
                val y = cy + (rnd.nextFloat() - 0.5f) * r * 0.9f
                p.shader = RadialGradient(x, y, r, intArrayOf(0xA0FFFFFF.toInt(), 0x00FFFFFF), null, Shader.TileMode.CLAMP)
                c.drawCircle(x, y, r, p)
            }
        }

        // Far mountains (hazy), then near mountains (darker).
        fun ridge(points: List<Pair<Float, Float>>, top: Int, bottom: Int, base: Float): Path {
            val path = Path()
            path.moveTo(0f, base)
            points.forEach { (fx, fy) -> path.lineTo(w * fx, h * fy) }
            path.lineTo(w.toFloat(), base)
            path.close()
            val minY = points.minOf { it.second } * h
            p.shader = LinearGradient(0f, minY, 0f, base, top, bottom, Shader.TileMode.CLAMP)
            c.drawPath(path, p)
            return path
        }
        val far = listOf(0f to 0.50f, 0.08f to 0.44f, 0.17f to 0.33f, 0.24f to 0.41f, 0.33f to 0.30f, 0.41f to 0.39f, 0.52f to 0.27f, 0.60f to 0.37f, 0.71f to 0.31f, 0.80f to 0.40f, 0.90f to 0.34f, 1f to 0.45f)
        ridge(far, 0xFF7E93B0.toInt(), 0xFFA7B8CB.toInt(), horizon)
        // Snow on the highest far peaks.
        p.shader = null
        p.color = 0xCCF4F7FB.toInt()
        listOf(0.17f to 0.33f, 0.33f to 0.30f, 0.52f to 0.27f, 0.71f to 0.31f).forEach { (fx, fy) ->
            val x = w * fx
            val y = h * fy
            c.drawPath(Path().apply { moveTo(x, y); lineTo(x - w * 0.025f, y + h * 0.045f); lineTo(x + w * 0.006f, y + h * 0.035f); lineTo(x + w * 0.028f, y + h * 0.046f); close() }, p)
        }
        val near = listOf(0f to 0.54f, 0.10f to 0.47f, 0.20f to 0.55f, 0.30f to 0.50f, 0.42f to 0.58f, 0.55f to 0.52f, 0.66f to 0.59f, 0.78f to 0.49f, 0.88f to 0.56f, 1f to 0.51f)
        ridge(near, 0xFF34465E.toInt(), 0xFF263445.toInt(), horizon)

        // Lake with a faint mirrored ridge.
        p.shader = LinearGradient(0f, horizon, 0f, h.toFloat(), intArrayOf(0xFF8AA3BE.toInt(), 0xFF4C6987.toInt(), 0xFF1D2D40.toInt()), floatArrayOf(0f, 0.4f, 1f), Shader.TileMode.CLAMP)
        c.drawRect(0f, horizon, w.toFloat(), h.toFloat(), p)
        c.save()
        c.scale(1f, -0.55f, 0f, horizon)
        p.shader = null
        p.color = 0x55263445
        c.drawPath(Path().apply { moveTo(0f, horizon); near.forEach { (fx, fy) -> lineTo(w * fx, h * fy) }; lineTo(w.toFloat(), horizon); close() }, p)
        c.restore()
        // Ripples.
        p.color = 0x22FFFFFF
        repeat(28) {
            val y = horizon + 12f + rnd.nextFloat() * (h - horizon - 20f)
            val x = rnd.nextFloat() * w
            c.drawRect(x, y, x + 60f + rnd.nextFloat() * 220f, y + 2f, p)
        }
        // Dark shoreline.
        p.color = 0xFF1E2A38.toInt()
        c.drawRect(0f, horizon - 3f, w.toFloat(), horizon + 4f, p)
        return bmp
    }

    /** A 16:9 placeholder banner: two-colour gradient, a simple mark and the app's name. */
    fun banner(name: String, from: Int, to: Int, text: Int = 0xFFFFFFFF.toInt(), mark: Int? = null, w: Int = 640, h: Int = 360): Bitmap {
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val p = Paint(Paint.ANTI_ALIAS_FLAG)
        p.shader = LinearGradient(0f, 0f, w.toFloat(), h.toFloat(), from, to, Shader.TileMode.CLAMP)
        c.drawRect(0f, 0f, w.toFloat(), h.toFloat(), p)
        p.shader = null
        val textSize = h * 0.20f
        p.textSize = textSize
        p.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        p.textAlign = Paint.Align.CENTER
        var x = w / 2f
        if (mark != null) {
            p.color = mark
            val r = h * 0.13f
            val textW = p.measureText(name)
            val markX = w / 2f - textW / 2f - r * 0.6f
            c.drawPath(Path().apply { moveTo(markX - r, h / 2f - r); lineTo(markX + r, h / 2f); lineTo(markX - r, h / 2f + r); close() }, p)
            x += r * 1.2f
        }
        p.color = text
        c.drawText(name, x, h / 2f + textSize * 0.36f, p)
        return bmp
    }

    /** A square placeholder app icon: rounded square with the first letter. */
    fun icon(letter: String, color: Int, size: Int = 192): Bitmap {
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val p = Paint(Paint.ANTI_ALIAS_FLAG)
        p.color = color
        c.drawRoundRect(RectF(size * 0.06f, size * 0.06f, size * 0.94f, size * 0.94f), size * 0.22f, size * 0.22f, p)
        p.color = 0xFFFFFFFF.toInt()
        p.textSize = size * 0.5f
        p.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        p.textAlign = Paint.Align.CENTER
        c.drawText(letter, size / 2f, size / 2f + size * 0.18f, p)
        return bmp
    }
}

/** An [ArtSource] backed by in-memory bitmaps, answering synchronously (so screenshots are deterministic). */
class FakeArtSource(
    private val banners: Map<String, Bitmap>,
    private val icons: Map<String, Bitmap>,
    private val images: Map<String, Bitmap>,
) : ArtSource {
    private val cache = HashMap<String, Art>()

    override fun peek(request: ArtRequest): Art = cache.getOrPut(request.key) { resolve(request) }

    override suspend fun load(request: ArtRequest): Art = peek(request)

    private fun resolve(r: ArtRequest): Art = when (r) {
        is ArtRequest.AppCard -> r.assetSha?.let { images[it] }?.let { Art(scale(it, r.widthPx, r.heightPx), ArtKind.ASSET) }
            ?: banners[r.app.packageName]?.takeIf { r.preferBanner }?.let { Art(scale(it, r.widthPx, r.heightPx), ArtKind.BANNER) }
            ?: icons[r.app.packageName]?.let { Art(scale(it, r.iconPx, r.iconPx), ArtKind.ICON) }
            ?: Art.None
        is ArtRequest.Image -> images[r.sha256]?.let { Art(scale(it, r.widthPx, r.heightPx), ArtKind.ASSET) } ?: Art.None
    }

    private fun scale(src: Bitmap, w: Int, h: Int) =
        (if (src.width == w && src.height == h) src else Bitmap.createScaledBitmap(src, w, h, true)).asImageBitmap()
}
