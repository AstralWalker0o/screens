package au.supercluster.screens.launcher.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import au.supercluster.screens.launcher.core.WifiQr
import kotlin.math.floor

/** Draws [content] as a crisp black-on-white QR code (module-aligned, with a quiet zone). */
@Composable
fun QrCode(content: String, description: String, modifier: Modifier = Modifier) {
    val matrix = remember(content) { runCatching { WifiQr.matrix(content) }.getOrNull() }
    Box(
        modifier
            .background(Color.White, RoundedCornerShape(12.dp))
            .padding(6.dp)
            .semantics { contentDescription = description },
    ) {
        if (matrix == null) return@Box
        Canvas(Modifier.fillMaxSize()) {
            val n = matrix.size
            val quiet = 2 // plus the 6dp padding: comfortably inside what phone cameras need
            val cell = floor(size.minDimension / (n + 2 * quiet)).coerceAtLeast(1f)
            val ox = floor((size.width - cell * n) / 2)
            val oy = floor((size.height - cell * n) / 2)
            for (y in 0 until n) {
                val row = matrix[y]
                var x = 0
                while (x < n) {
                    if (!row[x]) {
                        x++
                        continue
                    }
                    val start = x
                    while (x < n && row[x]) x++
                    drawRect(
                        color = Color.Black,
                        topLeft = Offset(ox + start * cell, oy + y * cell),
                        size = Size((x - start) * cell, cell),
                    )
                }
            }
        }
    }
}
