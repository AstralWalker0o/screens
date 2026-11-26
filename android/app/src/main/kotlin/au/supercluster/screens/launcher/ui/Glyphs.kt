package au.supercluster.screens.launcher.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import au.supercluster.screens.launcher.R
import au.supercluster.screens.launcher.core.RowIcon
import au.supercluster.screens.launcher.data.NetworkKind
import au.supercluster.screens.launcher.data.NetworkStatus
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/*
 * Simple geometric glyphs drawn on a 24x24 grid. They are our own drawings (no icon font or
 * third-party artwork), so they render the same on every box and in JVM screenshot tests.
 */

/** Row header icon. [RowIcon.NONE] draws nothing. */
@Composable
fun RowIconGlyph(icon: RowIcon, color: Color, size: Dp, modifier: Modifier = Modifier) {
    when (icon) {
        RowIcon.NONE -> Unit
        RowIcon.SETTINGS -> Image(
            painter = painterResource(R.drawable.ic_settings),
            contentDescription = null,
            colorFilter = ColorFilter.tint(color),
            modifier = modifier.size(size),
        )
        else -> Canvas(modifier.size(size)) { onGrid { drawRowIcon(icon, color) } }
    }
}

/** Wi-Fi (with signal level), Ethernet, or "no network". */
@Composable
fun NetworkGlyph(status: NetworkStatus, color: Color, size: Dp, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) {
        onGrid {
            when (status.kind) {
                NetworkKind.ETHERNET -> drawEthernet(color)
                NetworkKind.WIFI, NetworkKind.OTHER -> drawWifi(color, status.wifiLevel.coerceIn(0, 4), crossed = false)
                NetworkKind.NONE -> drawWifi(color, 0, crossed = true)
            }
        }
    }
}

/** Runs [block] with the canvas scaled so that 24 units span the drawing area. */
private inline fun DrawScope.onGrid(block: DrawScope.() -> Unit) {
    val k = size.minDimension / 24f
    scale(k, k, pivot = Offset.Zero) { block() }
}

private fun stroke(width: Float = 2f) = Stroke(width = width, cap = StrokeCap.Round, join = StrokeJoin.Round)

private fun DrawScope.drawRowIcon(icon: RowIcon, color: Color) {
    when (icon) {
        RowIcon.BOOKMARK -> drawPath(
            Path().apply {
                moveTo(6.5f, 3f)
                lineTo(17.5f, 3f)
                quadraticTo(19f, 3f, 19f, 4.5f)
                lineTo(19f, 21f)
                lineTo(12f, 16.5f)
                lineTo(5f, 21f)
                lineTo(5f, 4.5f)
                quadraticTo(5f, 3f, 6.5f, 3f)
                close()
            },
            color,
        )
        RowIcon.MEDIA -> {
            drawRoundRect(color, Offset(2.5f, 4.5f), Size(19f, 15f), CornerRadius(3f), style = stroke())
            drawPath(
                Path().apply {
                    moveTo(10f, 8.5f)
                    lineTo(15.5f, 12f)
                    lineTo(10f, 15.5f)
                    close()
                },
                color,
            )
        }
        RowIcon.STAR -> drawPath(starPath(12f, 12.5f, 10.5f, 4.4f), color)
        RowIcon.TV -> {
            drawRoundRect(color, Offset(2.5f, 4f), Size(19f, 13f), CornerRadius(2.5f), style = stroke())
            drawLine(color, Offset(8f, 20.5f), Offset(16f, 20.5f), strokeWidth = 2f, cap = StrokeCap.Round)
        }
        RowIcon.MUSIC -> {
            drawCircle(color, 3f, Offset(7f, 17.5f))
            drawCircle(color, 3f, Offset(17f, 15.5f))
            drawLine(color, Offset(9.6f, 17.5f), Offset(9.6f, 5.5f), strokeWidth = 2f, cap = StrokeCap.Round)
            drawLine(color, Offset(19.6f, 15.5f), Offset(19.6f, 3.5f), strokeWidth = 2f, cap = StrokeCap.Round)
            drawLine(color, Offset(9.6f, 5.5f), Offset(19.6f, 3.5f), strokeWidth = 3f, cap = StrokeCap.Round)
        }
        RowIcon.GAMES -> {
            drawRoundRect(color, Offset(2f, 7f), Size(20f, 11f), CornerRadius(5.5f), style = stroke())
            drawLine(color, Offset(7f, 10f), Offset(7f, 15f), strokeWidth = 2f, cap = StrokeCap.Round)
            drawLine(color, Offset(4.5f, 12.5f), Offset(9.5f, 12.5f), strokeWidth = 2f, cap = StrokeCap.Round)
            drawCircle(color, 1.3f, Offset(15.5f, 11f))
            drawCircle(color, 1.3f, Offset(18.2f, 13.8f))
        }
        RowIcon.KIDS -> {
            drawCircle(color, 9.5f, Offset(12f, 12f), style = stroke())
            drawCircle(color, 1.4f, Offset(8.8f, 10f))
            drawCircle(color, 1.4f, Offset(15.2f, 10f))
            drawArc(color, 20f, 140f, false, Offset(7.5f, 9f), Size(9f, 7.5f), style = stroke())
        }
        RowIcon.APPS -> {
            for (row in 0..2) for (col in 0..2) {
                drawRoundRect(color, Offset(3f + col * 7f, 3f + row * 7f), Size(4.4f, 4.4f), CornerRadius(1.2f))
            }
        }
        RowIcon.SETTINGS, RowIcon.NONE -> Unit
    }
}

private fun starPath(cx: Float, cy: Float, outer: Float, inner: Float): Path = Path().apply {
    for (i in 0 until 10) {
        val r = if (i % 2 == 0) outer else inner
        val a = -PI / 2 + i * PI / 5
        val x = cx + (r * cos(a)).toFloat()
        val y = cy + (r * sin(a)).toFloat()
        if (i == 0) moveTo(x, y) else lineTo(x, y)
    }
    close()
}

/** Three arcs and a dot; [level] 0–4 decides how many are lit (the rest are faint). */
private fun DrawScope.drawWifi(color: Color, level: Int, crossed: Boolean) {
    val faint = color.copy(alpha = color.alpha * 0.3f)
    val center = Offset(12f, 19.5f)
    drawCircle(if (level >= 1) color else faint, 1.7f, center)
    val radii = floatArrayOf(5.5f, 10f, 14.5f)
    radii.forEachIndexed { i, r ->
        drawArc(
            color = if (level >= i + 2) color else faint,
            startAngle = 225f,
            sweepAngle = 90f,
            useCenter = false,
            topLeft = Offset(center.x - r, center.y - r),
            size = Size(r * 2, r * 2),
            style = stroke(2.2f),
        )
    }
    if (crossed) drawLine(color, Offset(4f, 4f), Offset(20f, 20f), strokeWidth = 2.2f, cap = StrokeCap.Round)
}

/** A small network diagram: one box on top wired to two below. */
private fun DrawScope.drawEthernet(color: Color) {
    drawRoundRect(color, Offset(9f, 2.5f), Size(6f, 5.5f), CornerRadius(1.2f))
    drawRoundRect(color, Offset(2.5f, 16f), Size(6f, 5.5f), CornerRadius(1.2f))
    drawRoundRect(color, Offset(15.5f, 16f), Size(6f, 5.5f), CornerRadius(1.2f))
    val s = stroke(1.8f)
    drawPath(
        Path().apply {
            moveTo(12f, 8f)
            lineTo(12f, 12f)
            moveTo(5.5f, 16f)
            lineTo(5.5f, 12f)
            lineTo(18.5f, 12f)
            lineTo(18.5f, 16f)
        },
        color,
        style = s,
    )
}
