package au.supercluster.screens.launcher.ui

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import androidx.tv.material3.Text
import au.supercluster.screens.launcher.core.CardSize
import au.supercluster.screens.launcher.core.CardStyle
import au.supercluster.screens.launcher.core.HomeTile
import au.supercluster.screens.launcher.core.LabelMode

/** Gap between two cards, on top of the room the focused card grows into. */
internal val CardGap = 16.dp

/** Focus zoom duration (docs/LAUNCHER-V2.md §3: about 150 ms). */
private const val FOCUS_MS = 150
private val OutlineWidth = 2.dp
private val GlowSpread = 16.dp
private const val GLOW_LAYERS = 8
private val LabelGap = 6.dp
private val CardBase = Color(0xFF1B1E26)

@Immutable
internal data class CardSpec(val width: Dp, val height: Dp, val corner: Dp)

/** Card sizes in dp (a 1080p TV is 960 x 540 dp). Banners are 16:9, posters 2:3. */
internal fun cardSpec(style: CardStyle, size: CardSize): CardSpec = when (style) {
    CardStyle.BANNER -> when (size) {
        CardSize.SMALL -> CardSpec(128.dp, 72.dp, 9.dp)
        CardSize.MEDIUM -> CardSpec(160.dp, 90.dp, 10.dp)
        CardSize.LARGE -> CardSpec(272.dp, 153.dp, 14.dp)
    }
    CardStyle.ICON -> when (size) {
        CardSize.SMALL -> CardSpec(80.dp, 80.dp, 16.dp)
        CardSize.MEDIUM -> CardSpec(104.dp, 104.dp, 20.dp)
        CardSize.LARGE -> CardSpec(136.dp, 136.dp, 24.dp)
    }
    CardStyle.POSTER -> when (size) {
        CardSize.SMALL -> CardSpec(96.dp, 144.dp, 9.dp)
        CardSize.MEDIUM -> CardSpec(120.dp, 180.dp, 10.dp)
        CardSize.LARGE -> CardSpec(156.dp, 234.dp, 14.dp)
    }
}

/** Icon size inside a card that has no banner/custom art. */
private fun iconSize(style: CardStyle, spec: CardSpec): Dp = when (style) {
    CardStyle.BANNER -> spec.height * 0.44f
    CardStyle.ICON -> spec.width * 0.58f
    CardStyle.POSTER -> spec.width * 0.46f
}

private val OkKeys = setOf(Key.DirectionCenter, Key.Enter, Key.NumPadEnter)

/**
 * One app card: art clipped to a rounded rectangle; on focus it zooms to [focusScale] (150 ms)
 * and gets a white outline and a soft glow, and its label shows per [labelMode]. The zoom, glow
 * and label fade are read in the draw phase, so focus animations never recompose.
 */
@Composable
internal fun HomeCard(
    tile: HomeTile,
    spec: CardSpec,
    style: CardStyle,
    focusScale: Float,
    labelMode: LabelMode,
    accent: Color,
    assetStored: Boolean,
    requester: FocusRequester,
    onFocused: () -> Unit,
    onKey: (KeyEvent) -> Boolean,
    onClick: () -> Unit,
) {
    var focused by remember { mutableStateOf(false) }
    var okDown by remember { mutableStateOf(false) }
    val progress = animateFloatAsState(
        targetValue = if (focused) 1f else 0f,
        animationSpec = tween(FOCUS_MS, easing = FastOutSlowInEasing),
        label = "focus",
    )
    val density = LocalDensity.current
    val request = remember(tile, spec, style, assetStored, density) {
        with(density) {
            ArtRequest.AppCard(
                app = tile.app,
                widthPx = spec.width.roundToPx(),
                heightPx = spec.height.roundToPx(),
                iconPx = iconSize(style, spec).roundToPx(),
                preferBanner = style == CardStyle.BANNER,
                assetSha = tile.art?.sha256?.takeIf { assetStored },
            )
        }
    }
    val art = rememberArt(request)
    val shape = remember(spec) { RoundedCornerShape(spec.corner) }
    val growthW = spec.width * (focusScale - 1f) / 2
    val growthH = spec.height * (focusScale - 1f) / 2

    Column(
        Modifier
            .width(spec.width)
            .zIndex(if (focused) 1f else 0f),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier
                .size(spec.width, spec.height)
                .graphicsLayer {
                    val s = 1f + (focusScale - 1f) * progress.value
                    scaleX = s
                    scaleY = s
                }
                .focusDecoration(spec.corner, progress)
                .clip(shape)
                .background(CardBase)
                .focusRequester(requester)
                .onFocusChanged {
                    focused = it.isFocused
                    if (it.isFocused) onFocused() else okDown = false
                }
                .onKeyEvent { event ->
                    if (event.key in OkKeys) {
                        // Launch on release, and only for a press that started on this card.
                        when (event.type) {
                            KeyEventType.KeyDown -> if (event.nativeKeyEvent.repeatCount == 0) okDown = true
                            KeyEventType.KeyUp -> if (okDown) {
                                okDown = false
                                onClick()
                            }
                        }
                        true
                    } else {
                        onKey(event)
                    }
                }
                .focusable()
                .pointerInput(onClick) { detectTapGestures { onClick() } },
        ) {
            CardArt(tile, art, style, spec, accent)
        }
        if (labelMode != LabelMode.NEVER) {
            Spacer(Modifier.height(growthH + LabelGap))
            Text(
                text = tile.label,
                style = TextStyle(
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Medium,
                    color = Color.White,
                    shadow = TextShadow,
                    textAlign = TextAlign.Center,
                ),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .requiredWidth(spec.width + growthW * 2)
                    .graphicsLayer {
                        alpha = if (labelMode == LabelMode.ALWAYS) 0.72f + 0.28f * progress.value else progress.value
                    },
            )
        }
    }
}

/** Glow behind and a white outline over the card, scaled by the focus [progress]. */
private fun Modifier.focusDecoration(corner: Dp, progress: State<Float>): Modifier = drawWithCache {
    val radius = corner.toPx()
    val spread = GlowSpread.toPx()
    val outline = OutlineWidth.toPx()
    onDrawWithContent {
        val p = progress.value
        if (p > 0.01f) {
            // A soft glow from stacked translucent rounded rectangles: works on every Android
            // version and needs no blur support from the renderer.
            for (i in GLOW_LAYERS downTo 1) {
                val inflate = spread * i / GLOW_LAYERS
                drawRoundRect(
                    color = Color.White.copy(alpha = 0.045f * p),
                    topLeft = Offset(-inflate, -inflate),
                    size = Size(size.width + inflate * 2, size.height + inflate * 2),
                    cornerRadius = CornerRadius(radius + inflate),
                )
            }
        }
        drawContent()
        if (p > 0.01f) {
            drawRoundRect(
                color = Color.White.copy(alpha = p),
                topLeft = Offset(outline / 2, outline / 2),
                size = Size(size.width - outline, size.height - outline),
                cornerRadius = CornerRadius((radius - outline / 2).coerceAtLeast(0f)),
                style = Stroke(outline),
            )
        }
    }
}

@Composable
private fun CardArt(tile: HomeTile, art: Art?, style: CardStyle, spec: CardSpec, accent: Color) {
    val bitmap = art?.bitmap
    when {
        art == null -> Unit // loading: the plain dark card
        bitmap != null && (art.kind == ArtKind.ASSET || art.kind == ArtKind.BANNER) -> Image(
            bitmap = bitmap,
            contentDescription = tile.label,
            contentScale = ContentScale.FillBounds,
            modifier = Modifier.fillMaxSize(),
        )
        else -> {
            // No banner: the app's icon centred on an accent-tinted card (with its name, except
            // on square icon cards, which are too small for it).
            val tint = remember(accent) {
                Brush.linearGradient(listOf(lerp(CardBase, accent, 0.62f), lerp(CardBase, accent, 0.26f)))
            }
            Column(
                Modifier
                    .fillMaxSize()
                    .background(tint)
                    .padding(horizontal = 8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                if (bitmap != null) {
                    Image(bitmap = bitmap, contentDescription = tile.label, modifier = Modifier.size(iconSize(style, spec)))
                }
                if (style != CardStyle.ICON) {
                    if (bitmap != null) Spacer(Modifier.height(spec.height * 0.05f))
                    Text(
                        text = tile.label,
                        style = TextStyle(
                            fontSize = if (spec.height < 80.dp) 11.sp else 13.sp,
                            fontWeight = FontWeight.Medium,
                            color = Color.White,
                            textAlign = TextAlign.Center,
                        ),
                        maxLines = if (style == CardStyle.POSTER) 2 else 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}
