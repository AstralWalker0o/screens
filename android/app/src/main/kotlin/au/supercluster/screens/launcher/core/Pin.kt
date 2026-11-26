package au.supercluster.screens.launcher.core

import java.security.MessageDigest

/**
 * Kiosk PIN handling. The config carries `pin_sha256`: the lower-case hex SHA-256 of the PIN's
 * UTF-8 digits (e.g. "1234" -> 03ac6742…). Comparison is constant-time.
 */
object Pin {
    const val MAX_LENGTH = 12

    fun sha256Hex(pin: String): String = Hashing.sha256Hex(pin.toByteArray(Charsets.UTF_8))

    /** True when [pin] hashes to [expectedSha256Hex]. A null/invalid expected hash never matches. */
    fun matches(pin: String, expectedSha256Hex: String?): Boolean {
        val expected = expectedSha256Hex?.let { Hashing.fromHex(it) } ?: return false
        if (expected.size != 32) return false
        return MessageDigest.isEqual(Hashing.sha256(pin.toByteArray(Charsets.UTF_8)), expected)
    }

    fun isRequired(config: LauncherConfig): Boolean = config.kiosk.enabled && config.kiosk.pinSha256 != null
}

/**
 * Slows down guessing at the TV: after [maxAttempts] wrong PINs in a row, entry is locked for
 * [lockoutMillis]. Each further failure after a lockout locks again immediately.
 */
class PinAttemptLimiter(
    private val maxAttempts: Int = 5,
    private val lockoutMillis: Long = 30_000,
) {
    private var failures = 0
    private var lockedUntil = 0L

    fun isLocked(nowMillis: Long): Boolean = nowMillis < lockedUntil

    /** Whole seconds left in the lockout (rounded up), or 0. */
    fun remainingSeconds(nowMillis: Long): Int =
        if (!isLocked(nowMillis)) 0 else ((lockedUntil - nowMillis + 999) / 1000).toInt()

    fun recordFailure(nowMillis: Long) {
        failures++
        if (failures >= maxAttempts) {
            lockedUntil = nowMillis + lockoutMillis
            failures = maxAttempts - 1
        }
    }

    fun recordSuccess() {
        failures = 0
        lockedUntil = 0
    }
}
