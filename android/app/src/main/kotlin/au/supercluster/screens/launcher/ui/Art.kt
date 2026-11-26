package au.supercluster.screens.launcher.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.ImageBitmap
import au.supercluster.screens.launcher.core.AppCandidate

/** What a card or the wallpaper needs drawn, at an exact pixel size. */
@Immutable
sealed interface ArtRequest {
    /** Cache key: equal requests produce the same art. */
    val key: String

    /**
     * Art for an app card, resolved in this order: the custom [assetSha] (only set when the
     * asset is stored), then the app's TV banner when [preferBanner], then the app's icon
     * rendered at [iconPx].
     */
    data class AppCard(
        /** The app; its `updatedAt` is part of the key, so new artwork shows after an update. */
        val app: AppCandidate,
        val widthPx: Int,
        val heightPx: Int,
        val iconPx: Int,
        val preferBanner: Boolean,
        val assetSha: String? = null,
    ) : ArtRequest {
        override val key: String =
            "card:${app.packageName}/${app.activityName}@${app.updatedAt}:${widthPx}x$heightPx:$iconPx:$preferBanner:${assetSha ?: "-"}"
    }

    /** A stored image asset, centre-cropped to fill [widthPx] x [heightPx]. */
    data class Image(val sha256: String, val widthPx: Int, val heightPx: Int) : ArtRequest {
        override val key: String = "img:$sha256:${widthPx}x$heightPx"
    }
}

enum class ArtKind { ASSET, BANNER, ICON, NONE }

/** Decoded art. [bitmap] is null only for [ArtKind.NONE]. */
@Immutable
class Art(val bitmap: ImageBitmap?, val kind: ArtKind) {
    companion object {
        val None = Art(null, ArtKind.NONE)
    }
}

/** Loads and caches art. The Android implementation is `data.ArtLoader`; tests use fakes. */
interface ArtSource {
    /** Art already in memory, or null. Must be cheap: it is called during composition. */
    fun peek(request: ArtRequest): Art?

    /** Loads (and caches) the art. Never throws; [Art.None] when there is nothing to show. */
    suspend fun load(request: ArtRequest): Art
}

object NoArtSource : ArtSource {
    override fun peek(request: ArtRequest): Art = Art.None
    override suspend fun load(request: ArtRequest): Art = Art.None
}

val LocalArtSource = staticCompositionLocalOf<ArtSource> { NoArtSource }

/**
 * The art for [request]: synchronously from the cache when possible (so cards scrolled back into
 * view never flash), otherwise loaded in the background. Null while loading.
 */
@Composable
fun rememberArt(request: ArtRequest?): Art? {
    val source = LocalArtSource.current
    if (request == null) return null
    var art by remember(request, source) { mutableStateOf(source.peek(request)) }
    LaunchedEffect(request, source) {
        if (art == null) art = source.load(request)
    }
    return art
}
