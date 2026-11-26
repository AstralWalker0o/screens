package au.supercluster.screens.launcher.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PinTest {
    private val hash1234 = "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4"

    @Test
    fun hashesUtf8DigitsWithSha256() {
        assertEquals(hash1234, Pin.sha256Hex("1234"))
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", Pin.sha256Hex(""))
    }

    @Test
    fun matchesCaseInsensitiveHash() {
        assertTrue(Pin.matches("1234", hash1234))
        assertTrue(Pin.matches("1234", hash1234.uppercase()))
        assertFalse(Pin.matches("1235", hash1234))
        assertFalse(Pin.matches("12345", hash1234))
        assertFalse(Pin.matches("", hash1234))
    }

    @Test
    fun invalidOrMissingHashNeverMatches() {
        assertFalse(Pin.matches("1234", null))
        assertFalse(Pin.matches("1234", "nothex"))
        assertFalse(Pin.matches("1234", hash1234.substring(2)))
    }

    @Test
    fun pinRequiredOnlyInKioskWithHash() {
        assertTrue(Pin.isRequired(LauncherConfig(kiosk = LauncherConfig.Kiosk(enabled = true, pinSha256 = hash1234))))
        assertFalse(Pin.isRequired(LauncherConfig(kiosk = LauncherConfig.Kiosk(enabled = true, pinSha256 = null))))
        assertFalse(Pin.isRequired(LauncherConfig(kiosk = LauncherConfig.Kiosk(enabled = false, pinSha256 = hash1234))))
    }

    @Test
    fun limiterLocksAfterRepeatedFailuresAndUnlocks() {
        val limiter = PinAttemptLimiter(maxAttempts = 3, lockoutMillis = 30_000)
        limiter.recordFailure(0)
        limiter.recordFailure(1)
        assertFalse(limiter.isLocked(2))
        limiter.recordFailure(2)
        assertTrue(limiter.isLocked(3))
        assertEquals(30, limiter.remainingSeconds(3))
        assertEquals(1, limiter.remainingSeconds(29_500))
        assertFalse(limiter.isLocked(30_002))
        // One more miss after a lockout locks again straight away.
        limiter.recordFailure(30_010)
        assertTrue(limiter.isLocked(30_011))
        limiter.recordSuccess()
        assertFalse(limiter.isLocked(30_012))
        limiter.recordFailure(30_013)
        assertFalse(limiter.isLocked(30_014))
    }
}
