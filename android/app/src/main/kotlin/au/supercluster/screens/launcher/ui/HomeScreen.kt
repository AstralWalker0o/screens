package au.supercluster.screens.launcher.ui

import android.text.format.DateFormat
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Icon
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import au.supercluster.screens.launcher.R
import au.supercluster.screens.launcher.core.HomeRow
import au.supercluster.screens.launcher.core.HomeTile
import au.supercluster.screens.launcher.core.LauncherConfig
import au.supercluster.screens.launcher.core.PinAttemptLimiter
import au.supercluster.screens.launcher.core.RowIcon
import au.supercluster.screens.launcher.data.NetworkStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Wall-clock source for the top-bar clock; screenshot tests pin it. */
val LocalNow = staticCompositionLocalOf<() -> Long> { { System.currentTimeMillis() } }

internal val ScreenPadding = 48.dp // TV overscan-safe horizontal margin

/** The focused row's cards sit this far down the screen (top edge of the card). */
private const val PIN_FRACTION = 0.40f
private val HeaderHeight = 26.dp
private val HeaderGap = 8.dp
private val RowGap = 16.dp
private const val ROW_FADE_MS = 220

internal val TextShadow = Shadow(Color.Black.copy(alpha = 0.6f), Offset(0f, 2f), blurRadius = 8f)

/**
 * The v2 home screen (docs/LAUNCHER-V2.md §3): full-bleed wallpaper, a top bar with the network
 * glyph, settings gear and clock, and titled rows of app cards. The focused row is pinned about
 * 40 % down the screen and rows above it fade out.
 *
 * D-pad: left/right within a row, up/down between rows keeping the column (a "sticky" column,
 * so passing through a short row doesn't lose it), up from the first row to the top bar.
 */
@Composable
fun HomeScreen(
    home: LauncherConfig.Home,
    rows: List<HomeRow>?,
    storedAssets: Set<String>,
    kiosk: Boolean,
    pinRequired: Boolean,
    network: NetworkStatus,
    homeRequests: Int,
    verifyPin: (String) -> Boolean,
    onLaunch: (HomeTile) -> Unit,
    onOpenSettings: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val focus = remember { HomeFocusState(scope) }
    var showPin by remember { mutableStateOf(false) }
    val limiter = remember { PinAttemptLimiter() }
    val accent = MaterialTheme.colorScheme.primary
    val visibleRows = rows.orEmpty()

    val openSettingsGated = { if (kiosk && pinRequired) showPin = true else onOpenSettings() }
    val settingsGear = home.topBar.settings
    // Kiosk without a gear keeps v1's escape hatch: a focusable clock, long-press OK for the PIN.
    val clockFocusable = kiosk && !settingsGear && home.topBar.clock
    SideEffect {
        focus.rows = visibleRows
        focus.topBarFocusable = settingsGear || clockFocusable
    }

    // Pressing Home while home closes the PIN prompt and returns to the first card.
    LaunchedEffect(homeRequests) {
        if (homeRequests > 0) {
            showPin = false
            focus.reset()
        }
    }
    // First focus, and recovery when the focused card disappears (config change, app removed).
    val signature = remember(visibleRows) { visibleRows.map { r -> r.key to r.tiles.map { it.packageName } } }
    LaunchedEffect(signature, showPin) {
        if (showPin) return@LaunchedEffect
        withFrameNanos { }
        if (!focus.hasFocus) {
            if (visibleRows.isNotEmpty()) focus.focus(0, 0) else focus.focusTopBar()
        }
    }

    Box(Modifier.fillMaxSize()) {
        Wallpaper(home.wallpaper, home.wallpaper?.asset?.sha256?.let { it in storedAssets } == true, accent)

        BoxWithConstraints(Modifier.fillMaxSize()) {
            val viewportHeight = maxHeight
            when {
                rows == null -> Unit // still loading: keep the screen calm
                rows.isEmpty() -> Text(
                    text = stringResource(R.string.no_apps),
                    style = TextStyle(fontSize = 22.sp, color = Color.White, shadow = TextShadow),
                    modifier = Modifier.align(Alignment.Center),
                )
                else -> {
                    val density = LocalDensity.current
                    val pin = viewportHeight * PIN_FRACTION
                    val pinPx = with(density) { pin.toPx() }
                    val first = rows.first()
                    val firstSpec = cardSpec(first.card, first.size)
                    val firstCardTop = HeaderHeight + HeaderGap + firstSpec.height * (home.focus.scale - 1f) / 2
                    val pinSpec = remember(pinPx) { PinnedRowSpec(pinPx) }
                    @OptIn(ExperimentalFoundationApi::class)
                    CompositionLocalProvider(LocalBringIntoViewSpec provides pinSpec) {
                        LazyColumn(
                            state = focus.columnState,
                            contentPadding = PaddingValues(
                                top = (pin - firstCardTop).coerceAtLeast(0.dp),
                                bottom = viewportHeight - pin,
                            ),
                            modifier = Modifier
                                .fillMaxSize()
                                .onFocusChanged { focus.rowsHaveFocus = it.hasFocus },
                        ) {
                            itemsIndexed(rows, key = { _, row -> row.key }) { index, row ->
                                HomeRowView(
                                    row = row,
                                    rowIndex = index,
                                    focus = focus,
                                    home = home,
                                    accent = accent,
                                    storedAssets = storedAssets,
                                    onLaunch = onLaunch,
                                )
                            }
                        }
                    }
                }
            }
        }

        TopBar(
            topBar = home.topBar,
            network = network,
            settingsGear = settingsGear,
            clockFocusable = clockFocusable,
            focus = focus,
            onSettings = openSettingsGated,
            modifier = Modifier.align(Alignment.TopEnd),
        )
    }

    if (showPin) {
        PinDialog(
            limiter = limiter,
            verify = verifyPin,
            onSuccess = {
                showPin = false
                onOpenSettings()
            },
            onDismiss = { showPin = false },
        )
    }
}

/** Scrolls the rows so the focused card's top edge sits at [pinPx] from the top. */
private class PinnedRowSpec(private val pinPx: Float) : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float = offset - pinPx
}

/** Keeps the focused card at least [leadingPx] / [trailingPx] away from the row's edges. */
private class RowEdgeSpec(private val leadingPx: Float, private val trailingPx: Float) : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float {
        val start = leadingPx
        val end = containerSize - trailingPx
        return when {
            offset < start -> offset - start
            offset + size > end -> minOf(offset + size - end, offset - start)
            else -> 0f
        }
    }
}

/**
 * Focus bookkeeping for the rows: which row is focused (for the fade and the pin), the sticky
 * column used by up/down, per-row scroll state and one [FocusRequester] per card.
 */
@Stable
internal class HomeFocusState(private val scope: CoroutineScope) {
    val columnState = LazyListState()
    var rows: List<HomeRow> = emptyList()
    var focusedRow by mutableIntStateOf(0)
        private set
    val topBarRequester = FocusRequester()
    var topBarFocusable = false
    var rowsHaveFocus = false
    var topBarHasFocus = false
    val hasFocus: Boolean get() = rowsHaveFocus || topBarHasFocus

    private var desiredColumn = 0
    private var verticalMove = false
    private val rowStates = HashMap<String, LazyListState>()
    private val requesters = HashMap<String, FocusRequester>()

    fun rowState(rowKey: String): LazyListState = rowStates.getOrPut(rowKey) { LazyListState() }

    fun requester(rowKey: String, packageName: String): FocusRequester =
        requesters.getOrPut("$rowKey/$packageName") { FocusRequester() }

    fun onCardFocused(rowIndex: Int, column: Int) {
        focusedRow = rowIndex
        if (!verticalMove) desiredColumn = column
        verticalMove = false
    }

    /** D-pad handling for a focused card. Left/right inside the row is Compose's own focus search. */
    fun onCardKey(rowIndex: Int, column: Int, event: KeyEvent): Boolean {
        if (event.type != KeyEventType.KeyDown) return false
        val row = rows.getOrNull(rowIndex) ?: return false
        return when (event.key) {
            Key.DirectionUp -> {
                if (rowIndex == 0) focusTopBar() else moveToRow(rowIndex - 1)
                true
            }
            Key.DirectionDown -> {
                if (rowIndex < rows.lastIndex) moveToRow(rowIndex + 1)
                true
            }
            Key.DirectionLeft -> column == 0 // nothing further left: don't let focus jump rows
            Key.DirectionRight -> column >= row.tiles.lastIndex
            else -> false
        }
    }

    fun onTopBarDown() {
        if (rows.isEmpty()) return
        moveToRow(focusedRow.coerceIn(0, rows.lastIndex))
    }

    fun focusTopBar() {
        if (topBarFocusable) topBarRequester.tryFocus()
    }

    fun reset() {
        desiredColumn = 0
        if (rows.isEmpty()) return
        focus(0, 0, resetScroll = true)
    }

    private fun moveToRow(target: Int) {
        val row = rows.getOrNull(target) ?: return
        verticalMove = true
        focus(target, desiredColumn.coerceAtMost(row.tiles.lastIndex))
    }

    /** Focuses card [column] of row [rowIndex], scrolling it into the composed range first if needed. */
    fun focus(rowIndex: Int, column: Int, resetScroll: Boolean = false) {
        val row = rows.getOrNull(rowIndex) ?: return
        val tile = row.tiles.getOrNull(column) ?: return
        val requester = requester(row.key, tile.packageName)
        if (!resetScroll && requester.tryFocus()) return
        scope.launch {
            if (resetScroll) {
                columnState.scrollToItem(0)
                rowStates.values.forEach { it.scrollToItem(0) }
            }
            if (columnState.layoutInfo.visibleItemsInfo.none { it.index == rowIndex }) columnState.scrollToItem(rowIndex)
            val rowState = rowState(row.key)
            if (rowState.layoutInfo.visibleItemsInfo.none { it.index == column }) rowState.scrollToItem(column)
            repeat(6) {
                withFrameNanos { }
                if (requester.tryFocus()) return@launch
            }
            verticalMove = false
        }
    }
}

internal fun FocusRequester.tryFocus(): Boolean = try {
    requestFocus(FocusDirection.Enter)
} catch (e: IllegalStateException) {
    false
}

@Composable
private fun HomeRowView(
    row: HomeRow,
    rowIndex: Int,
    focus: HomeFocusState,
    home: LauncherConfig.Home,
    accent: Color,
    storedAssets: Set<String>,
    onLaunch: (HomeTile) -> Unit,
) {
    val scale = home.focus.scale
    val spec = cardSpec(row.card, row.size)
    val growthW = spec.width * (scale - 1f) / 2
    val growthH = spec.height * (scale - 1f) / 2
    val focusedRow = focus.focusedRow
    val rowAlpha by animateFloatAsState(if (rowIndex < focusedRow) 0f else 1f, tween(ROW_FADE_MS), label = "rowAlpha")
    val headerAlpha by animateFloatAsState(if (rowIndex == focusedRow) 1f else 0.55f, tween(ROW_FADE_MS), label = "headerAlpha")
    val density = LocalDensity.current
    val edgeSpec = remember(density, growthW) {
        with(density) { RowEdgeSpec((ScreenPadding).toPx(), (ScreenPadding + 56.dp).toPx()) }
    }

    Column(
        Modifier
            .fillMaxWidth()
            .zIndex(if (rowIndex == focusedRow) 1f else 0f)
            .graphicsLayer { alpha = rowAlpha },
    ) {
        RowHeader(row, Modifier.graphicsLayer { alpha = headerAlpha })
        Spacer(Modifier.height(growthH + HeaderGap))
        @OptIn(ExperimentalFoundationApi::class)
        CompositionLocalProvider(LocalBringIntoViewSpec provides edgeSpec) {
            LazyRow(
                state = focus.rowState(row.key),
                contentPadding = PaddingValues(horizontal = ScreenPadding),
                horizontalArrangement = Arrangement.spacedBy(CardGap + growthW),
                modifier = Modifier.fillMaxWidth(),
            ) {
                itemsIndexed(row.tiles, key = { _, tile -> tile.packageName }) { column, tile ->
                    HomeCard(
                        tile = tile,
                        spec = spec,
                        style = row.card,
                        focusScale = scale,
                        labelMode = home.focus.label,
                        accent = accent,
                        assetStored = tile.art?.sha256?.let { it in storedAssets } == true,
                        requester = focus.requester(row.key, tile.packageName),
                        onFocused = { focus.onCardFocused(rowIndex, column) },
                        onKey = { focus.onCardKey(rowIndex, column, it) },
                        onClick = { onLaunch(tile) },
                    )
                }
            }
        }
        Spacer(Modifier.height(RowGap))
    }
}

@Composable
private fun RowHeader(row: HomeRow, modifier: Modifier = Modifier) {
    val title = if (row.isAllApps && row.title.isEmpty()) stringResource(R.string.all_apps) else row.title
    Row(
        modifier
            .padding(start = ScreenPadding)
            .height(HeaderHeight),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RowIconGlyph(row.icon, Color.White, 18.dp)
        if (row.icon != RowIcon.NONE && title.isNotEmpty()) Spacer(Modifier.width(9.dp))
        if (title.isNotEmpty()) {
            Text(
                text = title,
                style = TextStyle(
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = Color.White,
                    letterSpacing = 0.2.sp,
                    shadow = TextShadow,
                ),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun TopBar(
    topBar: LauncherConfig.TopBar,
    network: NetworkStatus,
    settingsGear: Boolean,
    clockFocusable: Boolean,
    focus: HomeFocusState,
    onSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier.padding(top = 18.dp, end = ScreenPadding - 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (topBar.network) {
            NetworkGlyph(network, Color.White.copy(alpha = 0.92f), 26.dp)
            Spacer(Modifier.width(if (settingsGear) 10.dp else 18.dp))
        }
        if (settingsGear) {
            GearButton(focus, onSettings)
            Spacer(Modifier.width(14.dp))
        }
        if (topBar.clock) {
            val keys = Modifier.onPreviewKeyEvent { topBarKey(it, focus) }
            if (clockFocusable) {
                Surface(
                    onClick = {},
                    onLongClick = onSettings,
                    modifier = keys
                        .focusRequester(focus.topBarRequester)
                        .onFocusChanged { focus.topBarHasFocus = it.hasFocus },
                    shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(16.dp)),
                    colors = ClickableSurfaceDefaults.colors(
                        containerColor = Color.Transparent,
                        contentColor = Color.White,
                        focusedContainerColor = Color.White.copy(alpha = 0.18f),
                        focusedContentColor = Color.White,
                        pressedContainerColor = Color.White.copy(alpha = 0.25f),
                        pressedContentColor = Color.White,
                    ),
                    scale = ClickableSurfaceDefaults.scale(focusedScale = 1f),
                ) {
                    Clock(topBar, Modifier.padding(horizontal = 12.dp))
                }
            } else {
                Clock(topBar)
            }
        }
    }
}

/**
 * Top-bar keys: down returns to the rows. The bar holds a single focusable item (the gear, or
 * the clock in kiosk without a gear), so up, left and right go nowhere.
 */
private fun topBarKey(event: KeyEvent, focus: HomeFocusState): Boolean {
    if (event.type != KeyEventType.KeyDown) return false
    return when (event.key) {
        Key.DirectionDown -> {
            focus.onTopBarDown()
            true
        }
        Key.DirectionUp, Key.DirectionLeft, Key.DirectionRight -> true
        else -> false
    }
}

@Composable
private fun GearButton(focus: HomeFocusState, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        modifier = Modifier
            .size(46.dp)
            .onPreviewKeyEvent { topBarKey(it, focus) }
            .focusRequester(focus.topBarRequester)
            .onFocusChanged { focus.topBarHasFocus = it.hasFocus },
        shape = ClickableSurfaceDefaults.shape(CircleShape),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = Color.Transparent,
            contentColor = Color.White,
            focusedContainerColor = Color.White,
            focusedContentColor = Color(0xFF111318),
            pressedContainerColor = Color.White.copy(alpha = 0.8f),
            pressedContentColor = Color(0xFF111318),
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.1f),
    ) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Icon(
                painter = painterResource(R.drawable.ic_settings),
                contentDescription = stringResource(R.string.settings),
                modifier = Modifier.size(26.dp),
            )
        }
    }
}

@Composable
private fun Clock(topBar: LauncherConfig.TopBar, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val now = LocalNow.current
    val use24h = topBar.clock24h ?: DateFormat.is24HourFormat(context)
    // Formatters are rebuilt on every tick so locale and time-zone changes show up at once; the
    // state only changes (and recomposes) when the text does.
    val text by produceState(formatClock(now(), use24h, topBar.date), use24h, topBar.date) {
        while (true) {
            value = formatClock(now(), use24h, topBar.date)
            delay(1_000L - now() % 1_000L)
        }
    }
    Column(modifier, horizontalAlignment = Alignment.End) {
        Text(
            text = text.first,
            style = TextStyle(
                fontSize = 64.sp,
                lineHeight = 70.sp,
                fontWeight = FontWeight.Thin,
                color = Color.White,
                letterSpacing = (-1).sp,
                shadow = TextShadow,
            ),
            maxLines = 1,
        )
        if (topBar.date) {
            Text(
                text = text.second,
                style = TextStyle(fontSize = 16.sp, color = Color.White.copy(alpha = 0.85f), shadow = TextShadow),
                maxLines = 1,
                textAlign = TextAlign.End,
            )
        }
    }
}

private fun formatClock(millis: Long, use24h: Boolean, withDate: Boolean): Pair<String, String> {
    val locale = Locale.getDefault()
    val date = Date(millis)
    val time = SimpleDateFormat(if (use24h) "HH:mm" else "h:mm", locale).format(date)
    val day = if (withDate) SimpleDateFormat(DateFormat.getBestDateTimePattern(locale, "EEEEdMMMM"), locale).format(date) else ""
    return time to day
}

/** Wallpaper (or the built-in gradient), dim overlay, and the soft left and bottom gradients. */
@Composable
private fun Wallpaper(wallpaper: LauncherConfig.Wallpaper?, stored: Boolean, accent: Color) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val request = if (wallpaper != null && stored && constraints.maxWidth > 0 && constraints.maxHeight > 0) {
            ArtRequest.Image(wallpaper.asset.sha256, constraints.maxWidth, constraints.maxHeight)
        } else {
            null
        }
        val bitmap = rememberArt(request)?.bitmap
        if (bitmap != null) {
            Image(bitmap, contentDescription = null, contentScale = ContentScale.FillBounds, modifier = Modifier.fillMaxSize())
        } else {
            FallbackBackground(accent)
        }
        val dim = if (bitmap != null) wallpaper?.dim ?: 0f else 0f
        Box(
            Modifier
                .fillMaxSize()
                .drawBehind {
                    if (dim > 0f) drawRect(Color.Black.copy(alpha = dim))
                    drawRect(
                        Brush.horizontalGradient(
                            0f to Color.Black.copy(alpha = 0.50f),
                            0.55f to Color.Transparent,
                        ),
                    )
                    drawRect(
                        Brush.verticalGradient(
                            0f to Color.Black.copy(alpha = 0.25f),
                            0.22f to Color.Transparent,
                            0.55f to Color.Transparent,
                            1f to Color.Black.copy(alpha = 0.65f),
                        ),
                    )
                },
        )
    }
}

/** The built-in dark gradient, tinted by the accent colour. */
@Composable
private fun FallbackBackground(accent: Color) {
    Box(
        Modifier
            .fillMaxSize()
            .drawBehind {
                drawRect(Brush.verticalGradient(listOf(Color(0xFF161B26), Color(0xFF07080C))))
                drawRect(
                    Brush.radialGradient(
                        colors = listOf(lerp(Color.Transparent, accent, 0.30f), Color.Transparent),
                        center = Offset(size.width * 0.12f, size.height * 0.05f),
                        radius = size.maxDimension * 0.75f,
                    ),
                )
                drawRect(
                    Brush.radialGradient(
                        colors = listOf(lerp(Color.Transparent, accent, 0.14f), Color.Transparent),
                        center = Offset(size.width * 0.95f, size.height * 1.0f),
                        radius = size.maxDimension * 0.6f,
                    ),
                )
            },
    )
}
