package au.supercluster.screens.launcher.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Button
import androidx.tv.material3.ButtonDefaults
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.SurfaceDefaults
import androidx.tv.material3.Text
import au.supercluster.screens.launcher.R
import au.supercluster.screens.launcher.core.LauncherConfig
import au.supercluster.screens.launcher.core.WifiQr
import au.supercluster.screens.launcher.core.WifiSecurity

private val PanelShape = RoundedCornerShape(20.dp)

/**
 * Full-screen guest welcome: title, message, Wi-Fi card with a join QR code, info section cards,
 * contact line and a single focused "Start watching" button.
 */
@Composable
fun WelcomeScreen(config: LauncherConfig, onStart: () -> Unit) {
    val welcome = config.welcome
    val accent = MaterialTheme.colorScheme.primary
    val startFocus = remember { FocusRequester() }
    val title = welcome.title.ifBlank {
        if (config.siteName.isBlank()) stringResource(R.string.welcome_default_title)
        else stringResource(R.string.welcome_title_for_site, config.siteName)
    }

    LaunchedEffect(Unit) {
        repeat(5) {
            withFrameNanos { }
            if (runCatching { startFocus.requestFocus() }.isSuccess) return@LaunchedEffect
        }
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .background(
                Brush.radialGradient(
                    colors = listOf(accent.copy(alpha = 0.30f), Color.Transparent),
                    center = Offset(0f, 0f),
                    radius = 1600f,
                ),
            ),
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .padding(horizontal = 56.dp, vertical = 27.dp) // TV overscan-safe margins,
        ) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(32.dp)) {
                Column(Modifier.weight(1f)) {
                    if (config.siteName.isNotBlank() && welcome.title.isNotBlank()) {
                        Text(
                            text = config.siteName.uppercase(),
                            style = MaterialTheme.typography.titleMedium.copy(letterSpacing = 2.sp, fontWeight = FontWeight.SemiBold),
                            color = accent,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Spacer(Modifier.height(6.dp))
                    }
                    Text(
                        text = title,
                        style = MaterialTheme.typography.displayMedium.copy(fontSize = 48.sp, fontWeight = FontWeight.SemiBold, lineHeight = 56.sp),
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (welcome.message.isNotBlank()) {
                        Spacer(Modifier.height(14.dp))
                        Text(
                            text = welcome.message,
                            style = MaterialTheme.typography.headlineSmall.copy(fontSize = 24.sp, lineHeight = 32.sp),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = if (welcome.wifi != null) 3 else 4,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                welcome.wifi?.let { WifiCard(it, Modifier.width(430.dp)) }
            }

            Spacer(Modifier.height(20.dp))
            if (welcome.sections.isNotEmpty()) {
                SectionGrid(welcome.sections, Modifier.weight(1f).fillMaxWidth())
            } else {
                Spacer(Modifier.weight(1f))
            }
            Spacer(Modifier.height(20.dp))

            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = welcome.contact,
                    style = MaterialTheme.typography.titleLarge.copy(fontSize = 22.sp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(24.dp))
                Button(
                    onClick = onStart,
                    modifier = Modifier.focusRequester(startFocus),
                    shape = ButtonDefaults.shape(RoundedCornerShape(32.dp)),
                    colors = ButtonDefaults.colors(
                        containerColor = accent.copy(alpha = 0.85f),
                        contentColor = MaterialTheme.colorScheme.onPrimary,
                        focusedContainerColor = accent,
                        focusedContentColor = MaterialTheme.colorScheme.onPrimary,
                        pressedContainerColor = accent,
                        pressedContentColor = MaterialTheme.colorScheme.onPrimary,
                    ),
                    scale = ButtonDefaults.scale(focusedScale = 1.06f),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 36.dp, vertical = 16.dp),
                ) {
                    Text(
                        text = stringResource(R.string.start_watching),
                        style = MaterialTheme.typography.titleLarge.copy(fontSize = 24.sp, fontWeight = FontWeight.SemiBold),
                    )
                }
            }
        }
    }
}

@Composable
private fun WifiCard(wifi: LauncherConfig.Wifi, modifier: Modifier = Modifier) {
    val accent = MaterialTheme.colorScheme.primary
    val payload = remember(wifi) { WifiQr.payload(wifi) }
    Surface(
        modifier = modifier,
        shape = PanelShape,
        colors = SurfaceDefaults.colors(
            containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f),
            contentColor = MaterialTheme.colorScheme.onSurface,
        ),
    ) {
        Row(
            Modifier.padding(20.dp),
            horizontalArrangement = Arrangement.spacedBy(20.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    text = stringResource(R.string.wifi).uppercase(),
                    style = MaterialTheme.typography.titleMedium.copy(letterSpacing = 2.sp, fontWeight = FontWeight.SemiBold),
                    color = accent,
                )
                Spacer(Modifier.height(12.dp))
                Label(stringResource(R.string.wifi_network))
                Text(
                    text = wifi.ssid,
                    style = MaterialTheme.typography.headlineSmall.copy(fontSize = 24.sp, fontWeight = FontWeight.SemiBold),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(12.dp))
                Label(stringResource(R.string.wifi_password))
                if (wifi.security == WifiSecurity.NOPASS) {
                    Text(stringResource(R.string.wifi_open_network), style = MaterialTheme.typography.titleLarge)
                } else {
                    // Monospace so guests can tell l / 1 / I and O / 0 apart.
                    Text(
                        text = wifi.password,
                        style = MaterialTheme.typography.headlineSmall.copy(fontSize = 24.sp, fontFamily = FontFamily.Monospace),
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                QrCode(
                    content = payload,
                    description = stringResource(R.string.wifi_scan_to_join),
                    modifier = Modifier.size(136.dp),
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    text = stringResource(R.string.wifi_scan_to_join),
                    style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.width(136.dp),
                )
            }
        }
    }
}

@Composable
private fun Label(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/** Up to 4 sections sit in one row; 5-6 wrap into two rows of three. */
@Composable
private fun SectionGrid(sections: List<LauncherConfig.Section>, modifier: Modifier = Modifier) {
    val columns = if (sections.size <= 4) sections.size else 3
    val rows = sections.chunked(columns)
    val compact = rows.size > 1
    Column(modifier, verticalArrangement = Arrangement.spacedBy(16.dp)) {
        rows.forEach { row ->
            Row(
                Modifier
                    .weight(1f)
                    .fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                row.forEach { section -> SectionCard(section, compact, Modifier.weight(1f).fillMaxHeight()) }
                repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

@Composable
private fun SectionCard(section: LauncherConfig.Section, compact: Boolean, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier,
        shape = PanelShape,
        colors = SurfaceDefaults.colors(
            containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f),
            contentColor = MaterialTheme.colorScheme.onSurface,
        ),
    ) {
        Column(Modifier.padding(horizontal = 22.dp, vertical = if (compact) 14.dp else 20.dp)) {
            if (section.title.isNotBlank()) {
                Text(
                    text = section.title,
                    style = MaterialTheme.typography.titleLarge.copy(fontSize = if (compact) 20.sp else 22.sp, fontWeight = FontWeight.SemiBold),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(if (compact) 4.dp else 8.dp))
            }
            if (section.body.isNotBlank()) {
                Text(
                    text = section.body,
                    style = MaterialTheme.typography.bodyLarge.copy(fontSize = if (compact) 17.sp else 19.sp, lineHeight = if (compact) 23.sp else 27.sp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
