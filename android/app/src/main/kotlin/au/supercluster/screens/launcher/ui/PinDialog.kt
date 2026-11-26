package au.supercluster.screens.launcher.ui

import android.os.SystemClock
import android.view.KeyEvent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Surface
import androidx.tv.material3.SurfaceDefaults
import androidx.tv.material3.Text
import au.supercluster.screens.launcher.R
import au.supercluster.screens.launcher.core.Pin
import au.supercluster.screens.launcher.core.PinAttemptLimiter
import kotlinx.coroutines.delay

private const val DELETE = "del"
private const val SUBMIT = "ok"

/**
 * PIN prompt driven entirely by the D-pad: a 3x4 keypad (digits, delete, OK). Number keys on
 * the remote work too. Wrong PINs are rate-limited by [limiter].
 */
@Composable
fun PinDialog(
    limiter: PinAttemptLimiter,
    verify: (String) -> Boolean,
    onSuccess: () -> Unit,
    onDismiss: () -> Unit,
) {
    var entered by remember { mutableStateOf("") }
    var wrong by remember { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    val firstKey = remember { FocusRequester() }
    val locked = limiter.isLocked(now)

    LaunchedEffect(Unit) {
        repeat(5) {
            withFrameNanos { }
            if (runCatching { firstKey.requestFocus() }.isSuccess) return@LaunchedEffect
        }
    }
    // Tick while locked so the countdown updates and the keypad unlocks by itself.
    LaunchedEffect(locked) {
        while (limiter.isLocked(SystemClock.elapsedRealtime())) {
            delay(250)
            now = SystemClock.elapsedRealtime()
        }
        now = SystemClock.elapsedRealtime()
    }

    fun press(key: String) {
        now = SystemClock.elapsedRealtime()
        if (limiter.isLocked(now)) return
        when (key) {
            DELETE -> entered = entered.dropLast(1)
            SUBMIT -> {
                if (entered.isEmpty()) return
                if (verify(entered)) {
                    limiter.recordSuccess()
                    entered = ""
                    onSuccess()
                } else {
                    limiter.recordFailure(now)
                    entered = ""
                    wrong = true
                }
            }
            else -> if (entered.length < Pin.MAX_LENGTH) {
                entered += key
                wrong = false
            }
        }
    }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(
            shape = RoundedCornerShape(24.dp),
            colors = SurfaceDefaults.colors(
                containerColor = MaterialTheme.colorScheme.surface,
                contentColor = MaterialTheme.colorScheme.onSurface,
            ),
            modifier = Modifier.onPreviewKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                when (val code = event.nativeKeyEvent.keyCode) {
                    in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> press((code - KeyEvent.KEYCODE_0).toString()).let { true }
                    in KeyEvent.KEYCODE_NUMPAD_0..KeyEvent.KEYCODE_NUMPAD_9 -> press((code - KeyEvent.KEYCODE_NUMPAD_0).toString()).let { true }
                    KeyEvent.KEYCODE_DEL -> press(DELETE).let { true }
                    KeyEvent.KEYCODE_NUMPAD_ENTER -> press(SUBMIT).let { true }
                    else -> false
                }
            },
        ) {
            Column(
                Modifier.padding(horizontal = 48.dp, vertical = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(stringResource(R.string.pin_title), style = MaterialTheme.typography.headlineMedium)
                Spacer(Modifier.height(4.dp))
                Text(
                    stringResource(R.string.pin_subtitle),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(14.dp))
                PinDots(entered.length)
                Spacer(Modifier.height(6.dp))
                Text(
                    text = when {
                        locked -> stringResource(R.string.pin_locked, limiter.remainingSeconds(now))
                        wrong -> stringResource(R.string.pin_wrong)
                        else -> " "
                    },
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.error,
                )
                Spacer(Modifier.height(10.dp))
                val rows = listOf(
                    listOf("1", "2", "3"),
                    listOf("4", "5", "6"),
                    listOf("7", "8", "9"),
                    listOf(DELETE, "0", SUBMIT),
                )
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    rows.forEach { row ->
                        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                            row.forEach { key ->
                                KeypadKey(
                                    key = key,
                                    // Keys stay focusable while locked (so focus never leaves the dialog);
                                    // presses are ignored until the lockout ends.
                                    modifier = (if (key == "1") Modifier.focusRequester(firstKey) else Modifier)
                                        .alpha(if (locked) 0.4f else 1f),
                                    onClick = { press(key) },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PinDots(count: Int) {
    val accent = MaterialTheme.colorScheme.primary
    Row(
        Modifier.height(20.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (count == 0) {
            repeat(4) { Box(Modifier.size(14.dp).background(MaterialTheme.colorScheme.surfaceVariant, CircleShape)) }
        } else {
            repeat(count) { Box(Modifier.size(16.dp).background(accent, CircleShape)) }
        }
    }
}

@Composable
private fun KeypadKey(key: String, modifier: Modifier, onClick: () -> Unit) {
    val accent = MaterialTheme.colorScheme.primary
    val label = when (key) {
        DELETE -> "⌫"
        SUBMIT -> stringResource(R.string.pin_ok)
        else -> key
    }
    Surface(
        onClick = onClick,
        modifier = modifier.size(width = 84.dp, height = 52.dp),
        shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(16.dp)),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
            contentColor = MaterialTheme.colorScheme.onSurface,
            focusedContainerColor = accent,
            focusedContentColor = MaterialTheme.colorScheme.onPrimary,
            pressedContainerColor = accent,
            pressedContentColor = MaterialTheme.colorScheme.onPrimary,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.08f),
    ) {
        Box(Modifier.width(84.dp).height(52.dp), contentAlignment = Alignment.Center) {
            Text(
                text = label,
                style = MaterialTheme.typography.headlineSmall.copy(fontSize = if (key == SUBMIT) 22.sp else 26.sp),
                fontWeight = FontWeight.Medium,
            )
        }
    }
}
