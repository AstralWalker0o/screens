package au.supercluster.screens.launcher.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.tv.material3.LocalContentColor
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.darkColorScheme

object ScreensColors {
    val Background = Color(0xFF0F1115)
    val Surface = Color(0xFF181B21)
    val SurfaceVariant = Color(0xFF232731)
    val OnSurface = Color(0xFFF2F4F8)
    val OnSurfaceMuted = Color(0xFFA9B0BC)
    val Error = Color(0xFFFF8A80)
}

/** Readable text colour on top of [accent]. */
fun onAccent(accent: Color): Color = if (accent.luminance() > 0.45f) Color(0xFF0B0D10) else Color.White

/** Dark, 10-foot theme built on Compose for TV Material, tinted by the configured accent. */
@Composable
fun ScreensTheme(accent: Color, content: @Composable () -> Unit) {
    val scheme = remember(accent) {
        darkColorScheme(
            primary = accent,
            onPrimary = onAccent(accent),
            secondary = accent,
            onSecondary = onAccent(accent),
            background = ScreensColors.Background,
            onBackground = ScreensColors.OnSurface,
            surface = ScreensColors.Surface,
            onSurface = ScreensColors.OnSurface,
            surfaceVariant = ScreensColors.SurfaceVariant,
            onSurfaceVariant = ScreensColors.OnSurfaceMuted,
            border = accent,
            error = ScreensColors.Error,
        )
    }
    MaterialTheme(colorScheme = scheme) {
        CompositionLocalProvider(LocalContentColor provides ScreensColors.OnSurface, content = content)
    }
}
