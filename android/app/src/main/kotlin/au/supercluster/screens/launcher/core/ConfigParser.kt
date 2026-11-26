package au.supercluster.screens.launcher.core

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.Base64

class ConfigException(message: String) : Exception(message)

/** Outcome of decoding + validating a config delivered over adb. */
sealed class ConfigResult {
    /** [json] is exactly the bytes that were validated; [sha256] is their lower-case hex digest. */
    class Ok(val config: LauncherConfig, val json: ByteArray, val sha256: String) : ConfigResult()
    data class Error(val message: String) : ConfigResult()
}

/**
 * Defensive parser for config JSON v1.
 *
 * - Input is capped at [MAX_JSON_BYTES] and must be strict UTF-8 JSON with an object at the top.
 * - `v` must be 1. Unknown fields are ignored; `null` means "not set" for optional fields.
 * - Identifiers (package names, PIN hash, accent colour, Wi-Fi fields) are validated strictly
 *   and a bad value rejects the whole config with an error naming the field.
 * - Display text is cleaned (control characters removed) and truncated to fixed limits so a
 *   long message can never stop a Wi-Fi password update from landing.
 */
object ConfigParser {
    const val MAX_JSON_BYTES = 64 * 1024
    const val MAX_BASE64_CHARS = (MAX_JSON_BYTES + 2) / 3 * 4 + 1024 // slack for whitespace
    const val MAX_PACKAGES = 500
    const val MAX_SECTIONS = 6

    const val MAX_SITE_NAME = 64
    const val MAX_TITLE = 120
    const val MAX_MESSAGE = 1000
    const val MAX_SECTION_TITLE = 80
    const val MAX_SECTION_BODY = 600
    const val MAX_CONTACT = 200
    const val MAX_SSID_BYTES = 32
    const val MAX_PASSWORD = 64

    private val PACKAGE_NAME = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$")
    private val SHA256_HEX = Regex("^[0-9a-fA-F]{64}$")
    private val COLOR_HEX = Regex("^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
    private val BASE64_URL_CHARS = Regex("[-_]")

    fun isValidPackageName(name: String): Boolean = name.length <= 255 && PACKAGE_NAME.matches(name)

    /** Decodes the `config_b64` extra and validates it. Never throws. */
    fun fromBase64(b64: String?): ConfigResult {
        if (b64 == null) return ConfigResult.Error("missing config_b64 extra")
        if (b64.length > MAX_BASE64_CHARS) return ConfigResult.Error("config too large (max $MAX_JSON_BYTES bytes)")
        val compact = b64.filterNot { it.isWhitespace() }
        if (compact.isEmpty()) return ConfigResult.Error("config_b64 is empty")
        val bytes = try {
            val decoder = if (BASE64_URL_CHARS.containsMatchIn(compact)) Base64.getUrlDecoder() else Base64.getDecoder()
            decoder.decode(compact)
        } catch (e: IllegalArgumentException) {
            return ConfigResult.Error("config_b64 is not valid base64")
        }
        return fromBytes(bytes)
    }

    /** Validates raw UTF-8 JSON bytes. Never throws. */
    fun fromBytes(bytes: ByteArray): ConfigResult = try {
        ConfigResult.Ok(parseBytes(bytes), bytes, Hashing.sha256Hex(bytes))
    } catch (e: ConfigException) {
        ConfigResult.Error(e.message ?: "invalid config")
    }

    @Throws(ConfigException::class)
    fun parseBytes(bytes: ByteArray): LauncherConfig {
        if (bytes.size > MAX_JSON_BYTES) throw ConfigException("config too large (max $MAX_JSON_BYTES bytes)")
        val text = try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
                .toString()
        } catch (e: CharacterCodingException) {
            throw ConfigException("config is not valid UTF-8")
        }
        return parse(text)
    }

    @Throws(ConfigException::class)
    fun parse(text: String): LauncherConfig {
        val root = try {
            Json.parse(text.removePrefix("﻿"))
        } catch (e: Json.ParseException) {
            throw ConfigException("invalid JSON: ${e.message}")
        }
        val obj = root as? Map<*, *> ?: throw ConfigException("config must be a JSON object")
        return readConfig(Node(obj, ""))
    }

    private fun readConfig(root: Node): LauncherConfig {
        when (val v = root.raw("v")) {
            null -> throw ConfigException("v: missing (expected 1)")
            is Number -> if (v.toDouble() != 1.0) throw ConfigException("v: unsupported config version $v")
            else -> throw ConfigException("v: expected number")
        }

        val siteName = cleanText(root.string("site_name"), MAX_SITE_NAME, multiline = false)
        val accent = root.string("accent")?.let { parseColor(it) ?: throw root.error("accent", "expected #RRGGBB or #AARRGGBB") }
            ?: LauncherConfig.DEFAULT_ACCENT

        val kioskNode = root.obj("kiosk")
        val kiosk = if (kioskNode == null) {
            LauncherConfig.Kiosk()
        } else {
            LauncherConfig.Kiosk(
                enabled = kioskNode.bool("enabled") ?: false,
                allowed = kioskNode.packages("allowed"),
                pinSha256 = kioskNode.string("pin_sha256")?.let {
                    if (!SHA256_HEX.matches(it)) throw kioskNode.error("pin_sha256", "expected 64 hex characters or null")
                    it.lowercase()
                },
            )
        }

        val pinned = root.packages("pinned")

        val w = root.obj("welcome")
        // A config has arrived, so the welcome screen defaults to on (docs: "welcome off unless a config has arrived").
        val welcome = LauncherConfig.Welcome(
            enabled = w?.bool("enabled") ?: true,
            showOnBoot = w?.bool("show_on_boot") ?: true,
            title = cleanText(w?.string("title"), MAX_TITLE, multiline = false),
            message = cleanText(w?.string("message"), MAX_MESSAGE, multiline = true),
            wifi = w?.obj("wifi")?.let { readWifi(it) },
            sections = w?.array("sections")?.let { readSections(w, it) } ?: emptyList(),
            contact = cleanText(w?.string("contact"), MAX_CONTACT, multiline = false),
        )

        return LauncherConfig(
            siteName = siteName,
            accentArgb = accent,
            kiosk = kiosk,
            pinned = pinned,
            welcome = welcome,
            showWelcome = root.bool("show_welcome") ?: false,
        )
    }

    private fun readWifi(node: Node): LauncherConfig.Wifi? {
        val ssid = node.string("ssid").orEmpty()
        val password = node.string("password").orEmpty()
        if (ssid.isBlank()) {
            if (password.isNotEmpty()) throw node.error("ssid", "required when a password is set")
            return null // nothing to show
        }
        if (ssid.toByteArray(Charsets.UTF_8).size > MAX_SSID_BYTES) throw node.error("ssid", "longer than $MAX_SSID_BYTES bytes")
        if (ssid.any { Character.isISOControl(it) }) throw node.error("ssid", "contains control characters")
        if (password.length > MAX_PASSWORD) throw node.error("password", "longer than $MAX_PASSWORD characters")
        if (password.any { Character.isISOControl(it) }) throw node.error("password", "contains control characters")

        val security = when (val raw = node.string("security")?.trim()) {
            null, "" -> if (password.isEmpty()) WifiSecurity.NOPASS else WifiSecurity.WPA
            else -> when (raw.uppercase()) {
                "WPA", "WPA2" -> WifiSecurity.WPA
                "WEP" -> WifiSecurity.WEP
                "NOPASS" -> WifiSecurity.NOPASS
                else -> throw node.error("security", "expected WPA, WEP or nopass")
            }
        }
        if (security != WifiSecurity.NOPASS && password.isEmpty()) throw node.error("password", "required for ${security.qrToken}")
        return LauncherConfig.Wifi(ssid, if (security == WifiSecurity.NOPASS) "" else password, security)
    }

    private fun readSections(parent: Node, items: List<Any?>): List<LauncherConfig.Section> {
        val out = ArrayList<LauncherConfig.Section>()
        items.forEachIndexed { index, item ->
            if (item == null) return@forEachIndexed
            val m = item as? Map<*, *> ?: throw parent.error("sections[$index]", "expected object")
            val node = Node(m, parent.child("sections[$index]"))
            val title = cleanText(node.string("title"), MAX_SECTION_TITLE, multiline = false)
            val body = cleanText(node.string("body"), MAX_SECTION_BODY, multiline = true)
            if ((title.isNotEmpty() || body.isNotEmpty()) && out.size < MAX_SECTIONS) out.add(LauncherConfig.Section(title, body))
        }
        return out
    }

    /** Parses `#RRGGBB` / `#AARRGGBB` into ARGB, or null. */
    fun parseColor(s: String): Int? {
        val t = s.trim()
        if (!COLOR_HEX.matches(t)) return null
        val v = t.substring(1).toLong(16)
        return if (t.length == 7) (0xFF000000L or v).toInt() else v.toInt()
    }

    /**
     * Removes control characters (keeping newlines when [multiline]), normalises line endings,
     * trims, and truncates to [max] code points with an ellipsis.
     */
    fun cleanText(s: String?, max: Int, multiline: Boolean): String {
        if (s.isNullOrEmpty()) return ""
        val normalized = s.replace("\r\n", "\n").replace('\r', '\n')
        val sb = StringBuilder(normalized.length)
        for (c in normalized) {
            when {
                c == '\n' -> sb.append(if (multiline) '\n' else ' ')
                c == '\t' -> sb.append(' ')
                Character.isISOControl(c) -> Unit
                else -> sb.append(c)
            }
        }
        var text = sb.toString().trim()
        if (multiline) text = text.replace(Regex("\n{3,}"), "\n\n")
        val count = text.codePointCount(0, text.length)
        if (count <= max) return text
        val end = text.offsetByCodePoints(0, max - 1)
        return text.substring(0, end).trimEnd() + "…"
    }

    /** A JSON object plus its path, for typed access with precise error messages. */
    private class Node(val map: Map<*, *>, val path: String) {
        fun child(key: String) = if (path.isEmpty()) key else "$path.$key"
        fun error(key: String, problem: String) = ConfigException("${child(key)}: $problem")
        fun raw(key: String): Any? = map[key]

        fun string(key: String): String? = when (val v = map[key]) {
            null -> null
            is String -> v
            else -> throw error(key, "expected string")
        }

        fun bool(key: String): Boolean? = when (val v = map[key]) {
            null -> null
            is Boolean -> v
            else -> throw error(key, "expected boolean")
        }

        fun obj(key: String): Node? = when (val v = map[key]) {
            null -> null
            is Map<*, *> -> Node(v, child(key))
            else -> throw error(key, "expected object")
        }

        fun array(key: String): List<Any?>? = when (val v = map[key]) {
            null -> null
            is List<*> -> v
            else -> throw error(key, "expected array")
        }

        fun packages(key: String): List<String> {
            val items = array(key) ?: return emptyList()
            if (items.size > MAX_PACKAGES) throw error(key, "more than $MAX_PACKAGES entries")
            val out = LinkedHashSet<String>()
            items.forEachIndexed { index, item ->
                val name = item as? String ?: throw error("$key[$index]", "expected string")
                if (!isValidPackageName(name)) throw error("$key[$index]", "invalid package name")
                out.add(name)
            }
            return out.toList()
        }
    }
}
