package dnsd

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const samplePolicy = `# screens-policy v1 id=p_balanced
b samsungacr.com acr
b samsungads.com ads
a samsungotn.net update
b ads.example.com ads
a cdn.ads.example.com
b example.org
a example.org keep
b Tracking.Example.NET. trk
b *.wild.example    wild
x ignored.example
b   spaced.example   cat   # trailing comment
`

func TestMatcherSemantics(t *testing.T) {
	m := ParsePolicy(samplePolicy)
	if m.Rules() != 10 {
		t.Fatalf("rules = %d", m.Rules())
	}
	cases := []struct {
		q       string
		verdict byte
		rule    string
		cat     string
	}{
		{"samsungacr.com", VerdictBlock, "samsungacr.com", "acr"},
		{"log-config.samsungacr.com", VerdictBlock, "samsungacr.com", "acr"},
		{"a.b.c.samsungads.com", VerdictBlock, "samsungads.com", "ads"},
		{"notsamsungacr.com", VerdictNone, "", ""},
		{"samsungotn.net", VerdictAllow, "samsungotn.net", "update"},
		{"x.samsungotn.net", VerdictAllow, "samsungotn.net", "update"},
		// Most specific wins: allow on a subdomain of a blocked domain.
		{"cdn.ads.example.com", VerdictAllow, "cdn.ads.example.com", ""},
		{"img.cdn.ads.example.com", VerdictAllow, "cdn.ads.example.com", ""},
		{"x.ads.example.com", VerdictBlock, "ads.example.com", "ads"},
		{"example.com", VerdictNone, "", ""},
		// Allow beats block at the same level.
		{"example.org", VerdictAllow, "example.org", "keep"},
		{"www.example.org", VerdictAllow, "example.org", "keep"},
		// Case and trailing dots normalised in rules.
		{"a.tracking.example.net", VerdictBlock, "tracking.example.net", "trk"},
		{"wild.example", VerdictBlock, "wild.example", "wild"},
		{"x.wild.example", VerdictBlock, "wild.example", "wild"},
		{"ignored.example", VerdictNone, "", ""},
		{"spaced.example", VerdictBlock, "spaced.example", "cat"},
		{"com", VerdictNone, "", ""},
		{"", VerdictNone, "", ""},
	}
	for _, c := range cases {
		v, rule, cat := m.Match(c.q)
		if v != c.verdict || rule != c.rule || cat != c.cat {
			t.Errorf("Match(%q) = %q %q %q, want %q %q %q", c.q, v, rule, cat, c.verdict, c.rule, c.cat)
		}
	}
}

func TestDecide(t *testing.T) {
	pol := ParsePolicy("b ads.com ads\na good.ads.com\n")
	inline := InlineMatcher([]string{"example.com", "x.ads.com"}, []string{"bad.com", "y.example.com"})
	cases := []struct {
		inline *Matcher
		pol    *Matcher
		name   string
		q      string
		want   Decision
	}{
		{nil, pol, "p", "t.ads.com", Decision{Block: true, Rule: "ads.com", Cat: "ads"}},
		{nil, pol, "p", "good.ads.com", Decision{Rule: "good.ads.com"}},
		{nil, pol, "p", "other.com", Decision{}},
		{nil, nil, "p", "t.ads.com", Decision{Rule: "policy_missing"}},
		{nil, nil, "", "t.ads.com", Decision{}},
		{inline, pol, "p", "x.ads.com", Decision{Rule: "client_allow"}},
		{inline, pol, "p", "sub.x.ads.com", Decision{Rule: "client_allow"}},
		{inline, pol, "p", "bad.com", Decision{Block: true, Rule: "client_block"}},
		{inline, pol, "p", "y.example.com", Decision{Block: true, Rule: "client_block"}},
		{inline, pol, "p", "z.example.com", Decision{Rule: "client_allow"}},
		{inline, pol, "p", "t.ads.com", Decision{Block: true, Rule: "ads.com", Cat: "ads"}},
		{inline, nil, "p", "bad.com", Decision{Block: true, Rule: "client_block"}},
	}
	for _, c := range cases {
		if got := Decide(c.inline, c.pol, c.name, c.q); got != c.want {
			t.Errorf("Decide(%q) = %+v want %+v", c.q, got, c.want)
		}
	}
}

// genPolicy writes a gzip'd policy with n rules and returns its path plus a
// sample of blocked names.
func genPolicy(tb testing.TB, n int) (string, []string) {
	tb.Helper()
	r := rand.New(rand.NewSource(1))
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	fmt.Fprintf(zw, "# screens-policy v1 id=p_big\n")
	tlds := []string{"com", "net", "org", "io", "tv", "co.uk"}
	cats := []string{"ads", "acr", "trackers", "malware", ""}
	var sample []string
	const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
	for i := 0; i < n; i++ {
		l := 6 + r.Intn(14)
		b := make([]byte, l)
		for j := range b {
			b[j] = letters[r.Intn(len(letters))]
		}
		d := string(b) + "." + tlds[r.Intn(len(tlds))]
		if r.Intn(4) == 0 {
			d = "sub" + fmt.Sprint(r.Intn(100)) + "." + d
		}
		verb := "b"
		if i%50 == 0 {
			verb = "a"
		}
		fmt.Fprintf(zw, "%s %s %s\n", verb, d, cats[r.Intn(len(cats))])
		if verb == "b" && len(sample) < 1000 {
			sample = append(sample, "x.y."+d)
		}
	}
	zw.Close()
	path := filepath.Join(tb.TempDir(), "p_big.gz")
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		tb.Fatal(err)
	}
	return path, sample
}

func TestLoad300kPolicy(t *testing.T) {
	path, sample := genPolicy(t, 300000)
	st, _ := os.Stat(path)
	start := time.Now()
	m, err := LoadPolicyFile(path)
	if err != nil {
		t.Fatal(err)
	}
	took := time.Since(start)
	t.Logf("loaded %d rules from %d KiB gz in %v", m.Rules(), st.Size()/1024, took)
	if m.Rules() != 300000 {
		t.Fatalf("rules %d", m.Rules())
	}
	if took > 5*time.Second {
		t.Fatalf("load took %v (> 5s)", took)
	}
	for _, q := range sample[:100] {
		if v, _, _ := m.Match(q); v != VerdictBlock {
			// a later "a" rule for the same domain may exist; tolerate allow
			if v == VerdictNone {
				t.Fatalf("%s not matched", q)
			}
		}
	}
	// Lookup speed.
	start = time.Now()
	const N = 200000
	for i := 0; i < N; i++ {
		m.Match(sample[i%len(sample)])
		m.Match("no.such.domain.example")
	}
	per := time.Since(start) / (2 * N)
	t.Logf("lookup: %v per query", per)
	if per > 20*time.Microsecond {
		t.Fatalf("lookup too slow: %v", per)
	}
}

func BenchmarkLoad300k(b *testing.B) {
	path, _ := genPolicy(b, 300000)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := LoadPolicyFile(path); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkMatch(b *testing.B) {
	path, sample := genPolicy(b, 300000)
	m, err := LoadPolicyFile(path)
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if i%2 == 0 {
			m.Match(sample[i%len(sample)])
		} else {
			m.Match("a.b.c.d.no-such-domain.example.com")
		}
	}
}
