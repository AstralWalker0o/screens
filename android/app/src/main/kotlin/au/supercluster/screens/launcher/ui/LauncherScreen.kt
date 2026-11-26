package au.supercluster.screens.launcher.ui

import android.text.format.DateFormat
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Border
import androidx.tv.material3.Card
import androidx.tv.material3.CardDefaults
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import au.supercluster.screens.launcher.R
import au.supercluster.screens.launcher.core.PinAttemptLimiter
import au.supercluster.screens.launcher.data.InstalledApp
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val CardShape = RoundedCornerShape(14.dp)
private const val COLUMNS = 5

// Artwork size for the v1 grid (as in 1.x): banners 384x216 px, icons 160 px.
private const val BANNER_W = 384
private const val BANNER_H = 216
private const val ICON_PX = 160

/**
 * The v1 home screen (configs without `home`): header (site name, clock + date) and a D-pad
 * grid of app cards. Configs with `home` use [HomeScreen].
 *
 * In kiosk mode there is no Settings tile; instead the clock is focusable and a long-press on
 * it asks for the PIN (or opens settings straight away when no PIN is configured).
 */
@Composable
fun LauncherScreen(
    siteName: String,
    kiosk: Boolean,
    pinRequired: Boolean,
    apps: List<InstalledApp>?,
    homeRequests: Int,
    verifyPin: (String) -> Boolean,
    onLaunch: (InstalledApp) -> Unit,
    onOpenSettings: () -> Unit,
) {
    var showPin by remember { mutableStateOf(false) }
    val limiter = remember { PinAttemptLimiter() }
    val clockFocus = remember { FocusRequester() }

    // Pressing Home while already home closes the PIN prompt.
    LaunchedEffect(homeRequests) { if (homeRequests > 0) showPin = false }

    Column(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        Header(
            siteName = siteName,
            clockFocusable = kiosk,
            clockFocus = clockFocus,
            onClockLongPress = { if (pinRequired) showPin = true else onOpenSettings() },
        )
        when {
            apps == null -> Unit // still loading: keep the screen calm, no spinner flash
            apps.isEmpty() && kiosk -> EmptyState(clockFocus)
            else -> AppGrid(
                apps = apps,
                showSettings = !kiosk,
                homeRequests = homeRequests,
                onLaunch = onLaunch,
                onOpenSettings = onOpenSettings,
            )
        }
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

@Composable
private fun Header(
    siteName: String,
    clockFocusable: Boolean,
    clockFocus: FocusRequester,
    onClockLongPress: () -> Unit,
) {
    val accent = MaterialTheme.colorScheme.primary
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = ScreenPadding, end = ScreenPadding - 12.dp, top = 28.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(width = 6.dp, height = 44.dp)
                .background(accent, RoundedCornerShape(3.dp)),
        )
        Spacer(Modifier.width(18.dp))
        Text(
            text = siteName.ifBlank { stringResource(R.string.app_name) },
            style = MaterialTheme.typography.headlineLarge.copy(fontSize = 34.sp, fontWeight = FontWeight.SemiBold),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Spacer(Modifier.width(24.dp))
        if (clockFocusable) {
            Surface(
                onClick = {},
                onLongClick = onClockLongPress,
                modifier = Modifier.focusRequester(clockFocus),
                shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(12.dp)),
                colors = ClickableSurfaceDefaults.colors(
                    containerColor = Color.Transparent,
                    contentColor = MaterialTheme.colorScheme.onSurface,
                    focusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
                    focusedContentColor = MaterialTheme.colorScheme.onSurface,
                    pressedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
                    pressedContentColor = MaterialTheme.colorScheme.onSurface,
                ),
                scale = ClickableSurfaceDefaults.scale(focusedScale = 1f),
            ) {
                Clock(Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
            }
        } else {
            Clock(Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
        }
    }
}

@Composable
private fun Clock(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val now = LocalNow.current
    // Formatters are rebuilt on every tick so 12/24 h, locale and time zone changes show up at once.
    val text by produceState(initialValue = formatNow(context, now())) {
        while (true) {
            value = formatNow(context, now())
            delay(1_000L - now() % 1_000L)
        }
    }
    Column(modifier, horizontalAlignment = Alignment.End) {
        Text(
            text = text.first,
            style = MaterialTheme.typography.displaySmall.copy(fontSize = 40.sp, fontWeight = FontWeight.Medium),
            maxLines = 1,
        )
        Text(
            text = text.second,
            style = MaterialTheme.typography.titleLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
        )
    }
}

private fun formatNow(context: android.content.Context, millis: Long): Pair<String, String> {
    val now = Date(millis)
    val locale = Locale.getDefault()
    val time = DateFormat.getTimeFormat(context).format(now)
    val date = SimpleDateFormat(DateFormat.getBestDateTimePattern(locale, "EEEEdMMMM"), locale).format(now)
    return time to date
}

@Composable
private fun AppGrid(
    apps: List<InstalledApp>,
    showSettings: Boolean,
    homeRequests: Int,
    onLaunch: (InstalledApp) -> Unit,
    onOpenSettings: () -> Unit,
) {
    val gridState = rememberLazyGridState()
    val firstFocus = remember { FocusRequester() }
    val hasItems = apps.isNotEmpty() || showSettings

    // Focus the first card when the grid first fills, and again whenever Home is pressed.
    LaunchedEffect(hasItems, homeRequests) {
        if (!hasItems) return@LaunchedEffect
        if (homeRequests > 0) gridState.scrollToItem(0)
        repeat(5) {
            withFrameNanos { }
            if (runCatching { firstFocus.requestFocus() }.isSuccess) return@LaunchedEffect
        }
    }

    LazyVerticalGrid(
        columns = GridCells.Fixed(COLUMNS),
        state = gridState,
        contentPadding = PaddingValues(start = ScreenPadding, end = ScreenPadding, top = 24.dp, bottom = 48.dp),
        horizontalArrangement = Arrangement.spacedBy(24.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        itemsIndexed(apps, key = { _, app -> app.key }) { index, app ->
            val art = rememberArt(
                remember(app.candidate) {
                    ArtRequest.AppCard(app.candidate, BANNER_W, BANNER_H, ICON_PX, preferBanner = true)
                },
            )
            AppCard(
                label = app.label,
                banner = art?.bitmap?.takeIf { art.kind == ArtKind.BANNER },
                icon = art?.bitmap?.takeIf { art.kind == ArtKind.ICON },
                focusRequester = if (index == 0) firstFocus else null,
                onClick = { onLaunch(app) },
            )
        }
        if (showSettings) {
            item(key = "screens:settings") {
                SettingsCard(
                    focusRequester = if (apps.isEmpty()) firstFocus else null,
                    onClick = onOpenSettings,
                )
            }
        }
    }
}

@Composable
private fun TileCard(
    label: String,
    focusRequester: FocusRequester?,
    onClick: () -> Unit,
    content: @Composable () -> Unit,
) {
    var focused by remember { mutableStateOf(false) }
    val accent = MaterialTheme.colorScheme.primary
    Column {
        Card(
            onClick = onClick,
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(16f / 9f)
                .then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier)
                .onFocusChanged { focused = it.isFocused },
            shape = CardDefaults.shape(CardShape),
            colors = CardDefaults.colors(
                containerColor = MaterialTheme.colorScheme.surfaceVariant,
                focusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
            ),
            border = CardDefaults.border(
                focusedBorder = Border(border = BorderStroke(3.dp, accent), shape = CardShape),
            ),
            scale = CardDefaults.scale(focusedScale = 1.08f),
        ) {
            content()
        }
        Text(
            text = label,
            style = MaterialTheme.typography.titleMedium.copy(fontSize = 18.sp),
            color = if (focused) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 12.dp, start = 2.dp, end = 2.dp),
        )
    }
}

@Composable
private fun AppCard(
    label: String,
    banner: ImageBitmap?,
    icon: ImageBitmap?,
    focusRequester: FocusRequester?,
    onClick: () -> Unit,
) {
    TileCard(label, focusRequester, onClick) {
        when {
            banner != null -> Image(
                bitmap = banner,
                contentDescription = label,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
            else -> Column(
                Modifier
                    .fillMaxSize()
                    .padding(12.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                if (icon != null) {
                    Image(bitmap = icon, contentDescription = null, modifier = Modifier.size(52.dp))
                    Spacer(Modifier.height(8.dp))
                }
                Text(
                    text = label,
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

@Composable
private fun SettingsCard(focusRequester: FocusRequester?, onClick: () -> Unit) {
    val label = stringResource(R.string.settings)
    TileCard(label, focusRequester, onClick) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Image(
                painter = painterResource(R.drawable.ic_settings),
                contentDescription = label,
                colorFilter = ColorFilter.tint(MaterialTheme.colorScheme.onSurface),
                modifier = Modifier.size(56.dp),
            )
        }
    }
}

@Composable
private fun EmptyState(clockFocus: FocusRequester) {
    // Nothing else is focusable, so park focus on the clock (the PIN entry point).
    LaunchedEffect(Unit) {
        repeat(5) {
            withFrameNanos { }
            if (runCatching { clockFocus.requestFocus() }.isSuccess) return@LaunchedEffect
        }
    }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(
            text = stringResource(R.string.no_apps),
            style = MaterialTheme.typography.headlineSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
