package au.supercluster.screens.launcher.core

import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.google.zxing.qrcode.encoder.Encoder

/** Builds the standard Wi-Fi join QR payload and its module matrix. */
object WifiQr {
    /** Characters that must be backslash-escaped in SSID and password: backslash ; , : " */
    private val SPECIAL = charArrayOf('\\', ';', ',', ':', '"')

    /** Backslash-escapes `\ ; , : "` as required by the WIFI: URI format. */
    fun escape(value: String): String {
        val sb = StringBuilder(value.length + 8)
        for (c in value) {
            if (c in SPECIAL) sb.append('\\')
            sb.append(c)
        }
        return sb.toString()
    }

    /** `WIFI:T:<sec>;S:<ssid>;P:<password>;;` (the password is empty for open networks). */
    fun payload(wifi: LauncherConfig.Wifi): String = payload(wifi.ssid, wifi.password, wifi.security)

    fun payload(ssid: String, password: String, security: WifiSecurity): String {
        val pass = if (security == WifiSecurity.NOPASS) "" else password
        return "WIFI:T:${security.qrToken};S:${escape(ssid)};P:${escape(pass)};;"
    }

    /**
     * Encodes [content] as a QR code (error correction M) and returns its modules,
     * `matrix[y][x] == true` meaning dark. No quiet zone is included.
     */
    fun matrix(content: String): Array<BooleanArray> {
        // Plain ASCII stays in the default byte mode with no ECI header, which every phone camera
        // reads; anything else is encoded as UTF-8.
        val hints = if (content.all { it.code < 0x80 }) emptyMap() else mapOf(EncodeHintType.CHARACTER_SET to "UTF-8")
        val qr = Encoder.encode(content, ErrorCorrectionLevel.M, hints)
        val m = qr.matrix
        return Array(m.height) { y -> BooleanArray(m.width) { x -> m.get(x, y).toInt() == 1 } }
    }
}
