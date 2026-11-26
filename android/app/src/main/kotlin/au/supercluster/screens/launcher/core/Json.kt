package au.supercluster.screens.launcher.core

/**
 * A small, strict RFC 8259 JSON reader and writer.
 *
 * It exists so that config parsing is plain Kotlin (testable on the JVM without Android's
 * org.json stubs) and so that we control the limits: nesting depth is capped and the whole
 * input must be a single value. Objects become [Map] (insertion ordered, last duplicate key
 * wins), arrays become [List], numbers become [Long] when integral and in range, otherwise
 * [Double].
 */
object Json {

    class ParseException(message: String, val offset: Int) : Exception("$message at offset $offset")

    const val MAX_DEPTH = 32

    fun parse(text: String): Any? = Reader(text).readDocument()

    /** Serializes maps, lists, strings, numbers, booleans and null. */
    fun write(value: Any?): String = StringBuilder().also { writeTo(it, value) }.toString()

    fun quote(s: String): String = StringBuilder(s.length + 2).also { writeString(it, s) }.toString()

    private fun writeTo(sb: StringBuilder, value: Any?) {
        when (value) {
            null -> sb.append("null")
            is String -> writeString(sb, value)
            is Boolean -> sb.append(value)
            is Int, is Long, is Short, is Byte -> sb.append(value)
            is Double -> {
                require(value.isFinite()) { "non-finite number" }
                if (value == Math.floor(value) && kotlin.math.abs(value) < 1e15) sb.append(value.toLong()) else sb.append(value)
            }
            is Float -> writeTo(sb, value.toDouble())
            is Map<*, *> -> {
                sb.append('{')
                var first = true
                for ((k, v) in value) {
                    if (!first) sb.append(',')
                    first = false
                    writeString(sb, k.toString())
                    sb.append(':')
                    writeTo(sb, v)
                }
                sb.append('}')
            }
            is Iterable<*> -> {
                sb.append('[')
                var first = true
                for (v in value) {
                    if (!first) sb.append(',')
                    first = false
                    writeTo(sb, v)
                }
                sb.append(']')
            }
            else -> throw IllegalArgumentException("unsupported JSON value: ${value::class.java.simpleName}")
        }
    }

    private fun writeString(sb: StringBuilder, s: String) {
        sb.append('"')
        for (c in s) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                '\b' -> sb.append("\\b")
                '\u000C' -> sb.append("\\f")
                else -> if (c < ' ' || c == ' ' || c == ' ') {
                    sb.append("\\u").append(String.format("%04x", c.code))
                } else {
                    sb.append(c)
                }
            }
        }
        sb.append('"')
    }

    private class Reader(private val s: String) {
        private var i = 0

        fun readDocument(): Any? {
            skipWs()
            val v = readValue(0)
            skipWs()
            if (i != s.length) fail("unexpected trailing characters")
            return v
        }

        private fun fail(msg: String): Nothing = throw ParseException(msg, i)

        private fun skipWs() {
            while (i < s.length) {
                when (s[i]) {
                    ' ', '\t', '\n', '\r' -> i++
                    else -> return
                }
            }
        }

        private fun readValue(depth: Int): Any? {
            if (depth > MAX_DEPTH) fail("nesting too deep")
            if (i >= s.length) fail("unexpected end of input")
            return when (val c = s[i]) {
                '{' -> readObject(depth + 1)
                '[' -> readArray(depth + 1)
                '"' -> readString()
                't' -> readLiteral("true", true)
                'f' -> readLiteral("false", false)
                'n' -> readLiteral("null", null)
                else -> if (c == '-' || c in '0'..'9') readNumber() else fail("unexpected character '${printable(c)}'")
            }
        }

        private fun readLiteral(word: String, value: Any?): Any? {
            if (!s.startsWith(word, i)) fail("invalid literal")
            i += word.length
            return value
        }

        private fun readObject(depth: Int): Map<String, Any?> {
            i++ // {
            val map = LinkedHashMap<String, Any?>()
            skipWs()
            if (peek() == '}') {
                i++
                return map
            }
            while (true) {
                skipWs()
                if (peek() != '"') fail("expected string key")
                val key = readString()
                skipWs()
                if (peek() != ':') fail("expected ':'")
                i++
                skipWs()
                map[key] = readValue(depth)
                skipWs()
                when (peek()) {
                    ',' -> i++
                    '}' -> {
                        i++
                        return map
                    }
                    else -> fail("expected ',' or '}'")
                }
            }
        }

        private fun readArray(depth: Int): List<Any?> {
            i++ // [
            val list = ArrayList<Any?>()
            skipWs()
            if (peek() == ']') {
                i++
                return list
            }
            while (true) {
                skipWs()
                list.add(readValue(depth))
                skipWs()
                when (peek()) {
                    ',' -> i++
                    ']' -> {
                        i++
                        return list
                    }
                    else -> fail("expected ',' or ']'")
                }
            }
        }

        private fun peek(): Char = if (i < s.length) s[i] else fail("unexpected end of input")

        private fun readString(): String {
            i++ // opening quote
            val sb = StringBuilder()
            while (true) {
                if (i >= s.length) fail("unterminated string")
                val c = s[i++]
                when {
                    c == '"' -> return sb.toString()
                    c == '\\' -> {
                        if (i >= s.length) fail("unterminated escape")
                        when (val e = s[i++]) {
                            '"' -> sb.append('"')
                            '\\' -> sb.append('\\')
                            '/' -> sb.append('/')
                            'b' -> sb.append('\b')
                            'f' -> sb.append('\u000C')
                            'n' -> sb.append('\n')
                            'r' -> sb.append('\r')
                            't' -> sb.append('\t')
                            'u' -> sb.append(readHex4())
                            else -> {
                                i--
                                fail("invalid escape '\\${printable(e)}'")
                            }
                        }
                    }
                    c < ' ' -> {
                        i--
                        fail("control character in string")
                    }
                    else -> sb.append(c)
                }
            }
        }

        private fun readHex4(): Char {
            if (i + 4 > s.length) fail("truncated \\u escape")
            var v = 0
            for (k in 0 until 4) {
                val d = Character.digit(s[i + k], 16)
                if (d < 0) fail("invalid \\u escape")
                v = v * 16 + d
            }
            i += 4
            return v.toChar()
        }

        private fun readNumber(): Any {
            val start = i
            if (s[i] == '-') i++
            if (i >= s.length) fail("invalid number")
            if (s[i] == '0') {
                i++
            } else if (s[i] in '1'..'9') {
                while (i < s.length && s[i] in '0'..'9') i++
            } else {
                fail("invalid number")
            }
            var integral = true
            if (i < s.length && s[i] == '.') {
                integral = false
                i++
                if (i >= s.length || s[i] !in '0'..'9') fail("invalid number")
                while (i < s.length && s[i] in '0'..'9') i++
            }
            if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
                integral = false
                i++
                if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
                if (i >= s.length || s[i] !in '0'..'9') fail("invalid number")
                while (i < s.length && s[i] in '0'..'9') i++
            }
            val text = s.substring(start, i)
            if (integral) text.toLongOrNull()?.let { return it }
            val d = text.toDouble()
            if (!d.isFinite()) fail("number out of range")
            return d
        }

        private fun printable(c: Char): String = if (c < ' ') String.format("\\u%04x", c.code) else c.toString()
    }
}
