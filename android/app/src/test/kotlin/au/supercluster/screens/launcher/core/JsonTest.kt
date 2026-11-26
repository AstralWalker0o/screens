package au.supercluster.screens.launcher.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class JsonTest {
    @Test
    fun parsesPrimitivesAndNesting() {
        val v = Json.parse("""{"a":1,"b":-2.5e1,"c":"x","d":true,"e":null,"f":[1,[2,{}]],"g":{"h":false}}""") as Map<*, *>
        assertEquals(1L, v["a"])
        assertEquals(-25.0, v["b"])
        assertEquals("x", v["c"])
        assertEquals(true, v["d"])
        assertNull(v["e"])
        assertEquals(listOf(1L, listOf(2L, emptyMap<String, Any?>())), v["f"])
        assertEquals(mapOf("h" to false), v["g"])
    }

    @Test
    fun decodesEscapesAndSurrogatePairs() {
        assertEquals("a\"b\\c/d\n\té😀", Json.parse("\"a\\\"b\\\\c\\/d\\n\\t\\u00e9\\ud83d\\ude00\""))
    }

    @Test
    fun keepsLastDuplicateKey() {
        assertEquals(mapOf("a" to 2L), Json.parse("""{"a":1,"a":2}"""))
    }

    @Test
    fun rejectsMalformedInput() {
        val bad = listOf(
            "", "{", "[1,]", """{"a":1,}""", "{'a':1}", "01", "1.", "-", "tru", "nul",
            "\"unterminated", "\"bad \\x escape\"", "\"raw\ncontrol\"", "{} {}", "[1] x", "NaN", "{\"a\" 1}",
        )
        for (input in bad) {
            assertThrows("should reject: $input", Json.ParseException::class.java) { Json.parse(input) }
        }
    }

    @Test
    fun capsNestingDepth() {
        val ok = "[".repeat(Json.MAX_DEPTH) + "]".repeat(Json.MAX_DEPTH)
        Json.parse(ok)
        val tooDeep = "[".repeat(Json.MAX_DEPTH + 2) + "]".repeat(Json.MAX_DEPTH + 2)
        assertThrows(Json.ParseException::class.java) { Json.parse(tooDeep) }
    }

    @Test
    fun writesAndRoundTrips() {
        val value = linkedMapOf("s" to "q\"\\\n\u0001", "n" to 3L, "d" to 1.5, "b" to false, "z" to null, "l" to listOf(1, "x"))
        val text = Json.write(value)
        assertEquals("""{"s":"q\"\\\n\u0001","n":3,"d":1.5,"b":false,"z":null,"l":[1,"x"]}""", text)
        assertEquals(mapOf("s" to "q\"\\\n\u0001", "n" to 3L, "d" to 1.5, "b" to false, "z" to null, "l" to listOf(1L, "x")), Json.parse(text))
    }
}
