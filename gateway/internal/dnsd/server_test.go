package dnsd

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/miekg/dns"

	"github.com/astralwalker0o/screens/gateway/internal/fetch"
	"github.com/astralwalker0o/screens/gateway/internal/netx"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// fakeUpstream answers every A query with 93.184.216.34 and AAAA with
// 2606:2800::1, and serves policy files under /agent/v1/files/.
type fakeUpstream struct {
	srv      *httptest.Server
	dohHits  atomic.Int64
	fail     atomic.Bool
	policies map[string][]byte
}

func answerFor(q *dns.Msg) *dns.Msg {
	r := new(dns.Msg)
	r.SetReply(q)
	r.RecursionAvailable = true
	qq := q.Question[0]
	switch qq.Qtype {
	case dns.TypeA:
		r.Answer = append(r.Answer, &dns.A{Hdr: dns.RR_Header{Name: qq.Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 300}, A: net.ParseIP("93.184.216.34")})
	case dns.TypeAAAA:
		r.Answer = append(r.Answer, &dns.AAAA{Hdr: dns.RR_Header{Name: qq.Name, Rrtype: dns.TypeAAAA, Class: dns.ClassINET, Ttl: 300}, AAAA: net.ParseIP("2606:2800::1")})
	}
	return r
}

func newFakeUpstream(t *testing.T) *fakeUpstream {
	f := &fakeUpstream{policies: map[string][]byte{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/dns-query", func(w http.ResponseWriter, r *http.Request) {
		f.dohHits.Add(1)
		if f.fail.Load() {
			http.Error(w, "down", 503)
			return
		}
		if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/dns-message" {
			http.Error(w, "bad", 400)
			return
		}
		body, _ := io.ReadAll(r.Body)
		q := new(dns.Msg)
		if err := q.Unpack(body); err != nil {
			http.Error(w, "bad", 400)
			return
		}
		if q.Id != 0 {
			http.Error(w, "id must be 0", 400)
			return
		}
		out, _ := answerFor(q).Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(out)
	})
	mux.HandleFunc("/agent/v1/files/", func(w http.ResponseWriter, r *http.Request) {
		b, ok := f.policies[filepath.Base(r.URL.Path)]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(b)
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func gz(t *testing.T, s string) ([]byte, string) {
	var b bytes.Buffer
	zw := gzip.NewWriter(&b)
	_, _ = zw.Write([]byte(s))
	zw.Close()
	sum := sha256.Sum256(b.Bytes())
	return b.Bytes(), hex.EncodeToString(sum[:])
}

func query(t *testing.T, network, addr, name string, qt uint16) *dns.Msg {
	t.Helper()
	c := &dns.Client{Net: network, Timeout: 3 * time.Second}
	m := new(dns.Msg)
	m.SetQuestion(dns.Fqdn(name), qt)
	r, _, err := c.Exchange(m, addr)
	if err != nil {
		t.Fatalf("query %s %s: %v", name, dns.TypeToString[qt], err)
	}
	return r
}

func mustCfg(t *testing.T, js string) Config {
	t.Helper()
	cfg, err := ParseConfig(json.RawMessage(js))
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func lastEntries(s *Server) map[string]LogEntry {
	out := map[string]LogEntry{}
	for _, e := range s.QueryLog().Drain(1000) {
		out[e.QName+"/"+e.QType] = e
	}
	return out
}

func TestServerEndToEnd(t *testing.T) {
	up := newFakeUpstream(t)
	polGz, polSHA := gz(t, "# test\nb ads.test ads\na good.ads.test\n")
	up.policies["p1"] = polGz
	dir := t.TempDir()
	s := New(dir, fetch.New(up.srv.URL), testLogger())
	defer s.Close()
	s.SetInterfaceSource(func() []netx.Iface { return nil })
	s.Upstreams().Fallback = ""

	cfgJSON := `{
	  "enabled": true, "listen": ["127.0.0.1:0"],
	  "upstreams": ["` + up.srv.URL + `/dns-query"],
	  "block_response": "null",
	  "cache": {"enabled": true, "max_entries": 100},
	  "default": {"policy": "", "mode": "monitor"},
	  "clients": {"127.0.0.1": {"device_id": "dev_1", "policy": "p1", "mode": "enforce", "allow": ["allowed.ads.test"], "block": ["inline-block.test"]}},
	  "policies": {"p1": {"version": "` + polSHA + `", "url": "` + up.srv.URL + `/agent/v1/files/p1", "sha256": "` + polSHA + `"}},
	  "log": {"enabled": true}
	}`
	st := s.Apply(mustCfg(t, cfgJSON))
	if len(st.Listening) != 1 {
		t.Fatalf("listening %+v", st)
	}
	addr := st.Listening[0]
	if !s.Policies().WaitIdle(5 * time.Second) {
		t.Fatal("policy download did not finish")
	}
	if v := s.Policies().Versions()["p1"]; v != polSHA {
		t.Fatalf("policy version %q", v)
	}
	if _, err := os.Stat(filepath.Join(dir, "dns", "p1.gz")); err != nil {
		t.Fatalf("policy not cached: %v", err)
	}

	// Blocked by policy → 0.0.0.0.
	r := query(t, "udp", addr, "tracker.ads.test", dns.TypeA)
	if r.Rcode != dns.RcodeSuccess || len(r.Answer) != 1 || r.Answer[0].(*dns.A).A.String() != "0.0.0.0" || r.Answer[0].Header().Ttl != 60 {
		t.Fatalf("block A: %v", r)
	}
	// AAAA → ::
	r = query(t, "udp", addr, "inline-block.test", dns.TypeAAAA)
	if len(r.Answer) != 1 || r.Answer[0].(*dns.AAAA).AAAA.String() != "::" {
		t.Fatalf("block AAAA: %v", r)
	}
	// Other types → empty NOERROR.
	r = query(t, "udp", addr, "inline-block.test", dns.TypeMX)
	if r.Rcode != dns.RcodeSuccess || len(r.Answer) != 0 {
		t.Fatalf("block MX: %v", r)
	}
	// Policy allow and inline allow pass through to upstream.
	r = query(t, "udp", addr, "good.ads.test", dns.TypeA)
	if len(r.Answer) != 1 || r.Answer[0].(*dns.A).A.String() != "93.184.216.34" {
		t.Fatalf("policy allow: %v", r)
	}
	r = query(t, "tcp", addr, "allowed.ads.test", dns.TypeA)
	if len(r.Answer) != 1 || r.Answer[0].(*dns.A).A.String() != "93.184.216.34" {
		t.Fatalf("inline allow over tcp: %v", r)
	}
	// Cache.
	hits := up.dohHits.Load()
	query(t, "udp", addr, "good.ads.test", dns.TypeA)
	if up.dohHits.Load() != hits {
		t.Fatal("second query not served from cache")
	}

	logs := lastEntries(s)
	e := logs["tracker.ads.test/A"]
	if e.Action != "block" || e.Rule != "ads.test" || e.Cat != "ads" || e.DeviceID != "dev_1" || e.Client != "127.0.0.1" || e.Proto != "udp" || len(e.Answers) != 1 || e.Answers[0] != "0.0.0.0" || e.RCode != "NOERROR" {
		t.Fatalf("block entry %+v", e)
	}
	if e := logs["inline-block.test/AAAA"]; e.Action != "block" || e.Rule != "client_block" {
		t.Fatalf("inline entry %+v", e)
	}
	if e := logs["allowed.ads.test/A"]; e.Action != "allow" || e.Rule != "client_allow" || e.Proto != "tcp" {
		t.Fatalf("inline allow entry %+v", e)
	}
	if e := logs["good.ads.test/A"]; e.Action != "allow" || e.Rule != "good.ads.test" || !e.Cached {
		t.Fatalf("allow entry %+v", e)
	}
	stats := s.Stats()
	if stats.Blocked != 3 || stats.CacheHits != 1 || stats.Queries != 6 {
		t.Fatalf("stats %+v", stats)
	}

	// Monitor mode: answer from upstream, log would_block.
	s.Apply(mustCfg(t, `{"enabled":true,"listen":["`+addr+`"],"upstreams":["`+up.srv.URL+`/dns-query"],
	  "clients":{"127.0.0.1":{"policy":"p1","mode":"monitor"}},
	  "policies":{"p1":{"version":"`+polSHA+`","url":"`+up.srv.URL+`/agent/v1/files/p1","sha256":"`+polSHA+`"}}}`))
	r = query(t, "udp", addr, "tracker.ads.test", dns.TypeA)
	if len(r.Answer) != 1 || r.Answer[0].(*dns.A).A.String() != "93.184.216.34" {
		t.Fatalf("monitor: %v", r)
	}
	if e := lastEntries(s)["tracker.ads.test/A"]; e.Action != "would_block" || e.Rule != "ads.test" {
		t.Fatalf("monitor entry %+v", e)
	}

	// NXDOMAIN block response.
	s.Apply(mustCfg(t, `{"enabled":true,"listen":["`+addr+`"],"upstreams":["`+up.srv.URL+`/dns-query"],"block_response":"nxdomain",
	  "clients":{"127.0.0.1":{"policy":"p1","mode":"enforce"}},
	  "policies":{"p1":{"version":"`+polSHA+`","url":"`+up.srv.URL+`/agent/v1/files/p1","sha256":"`+polSHA+`"}}}`))
	r = query(t, "udp", addr, "tracker.ads.test", dns.TypeA)
	if r.Rcode != dns.RcodeNameError {
		t.Fatalf("nxdomain: %v", r)
	}

	// Missing policy → allow, rule policy_missing.
	s.Apply(mustCfg(t, `{"enabled":true,"listen":["`+addr+`"],"upstreams":["`+up.srv.URL+`/dns-query"],
	  "default":{"policy":"p_missing","mode":"enforce"},
	  "policies":{"p_missing":{"version":"v1","url":"`+up.srv.URL+`/agent/v1/files/nope"}}}`))
	lastEntries(s)
	query(t, "udp", addr, "tracker.ads.test", dns.TypeA)
	if e := lastEntries(s)["tracker.ads.test/A"]; e.Action != "allow" || e.Rule != "policy_missing" {
		t.Fatalf("missing entry %+v", e)
	}
	if _, ok := s.Policies().Versions()["p1"]; ok {
		t.Fatal("unreferenced policy still loaded")
	}

	// Bypass → not logged; off → logged, no filtering.
	s.Apply(mustCfg(t, `{"enabled":true,"listen":["`+addr+`"],"upstreams":["`+up.srv.URL+`/dns-query"],"clients":{"127.0.0.1":{"mode":"bypass","block":["x.test"]}}}`))
	query(t, "udp", addr, "x.test", dns.TypeA)
	if n := s.QueryLog().Len(); n != 0 {
		t.Fatalf("bypass logged %d", n)
	}
	s.Apply(mustCfg(t, `{"enabled":true,"listen":["`+addr+`"],"upstreams":["`+up.srv.URL+`/dns-query"],"clients":{"127.0.0.1":{"mode":"off","block":["x.test"]}}}`))
	r = query(t, "udp", addr, "x.test", dns.TypeA)
	if len(r.Answer) != 1 || r.Answer[0].(*dns.A).A.String() != "93.184.216.34" {
		t.Fatalf("off mode filtered: %v", r)
	}
	if e := lastEntries(s)["x.test/A"]; e.Action != "allow" {
		t.Fatalf("off entry %+v", e)
	}

	// Disabled → listener stops.
	st = s.Apply(mustCfg(t, `{"enabled":false}`))
	if len(st.Listening) != 0 {
		t.Fatalf("still listening %v", st.Listening)
	}
}

func TestUpstreamFailoverAndFallback(t *testing.T) {
	bad := newFakeUpstream(t)
	bad.fail.Store(true)
	good := newFakeUpstream(t)

	// Local plain-DNS server for the fallback.
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var fallbackHits atomic.Int64
	fs := &dns.Server{PacketConn: pc, Handler: dns.HandlerFunc(func(w dns.ResponseWriter, r *dns.Msg) {
		fallbackHits.Add(1)
		_ = w.WriteMsg(answerFor(r))
	})}
	go fs.ActivateAndServe()
	defer fs.Shutdown()

	u := NewUpstreams()
	var errs atomic.Int64
	u.OnError = func() { errs.Add(1) }
	u.Fallback = pc.LocalAddr().String()
	u.SetURLs([]string{bad.srv.URL + "/dns-query", good.srv.URL + "/dns-query"})
	q := new(dns.Msg)
	q.SetQuestion("a.example.", dns.TypeA)
	r, err := u.Exchange(t.Context(), q)
	if err != nil || r.Id != q.Id || len(r.Answer) != 1 {
		t.Fatalf("failover: %v %v", r, err)
	}
	if bad.dohHits.Load() != 1 || good.dohHits.Load() != 1 || errs.Load() != 1 {
		t.Fatalf("hits bad=%d good=%d errs=%d", bad.dohHits.Load(), good.dohHits.Load(), errs.Load())
	}
	// The failed upstream is now tried last.
	if _, err := u.Exchange(t.Context(), q); err != nil {
		t.Fatal(err)
	}
	if bad.dohHits.Load() != 1 || good.dohHits.Load() != 2 {
		t.Fatalf("unhealthy not deprioritised: bad=%d good=%d", bad.dohHits.Load(), good.dohHits.Load())
	}
	// Everything down → UDP fallback.
	good.fail.Store(true)
	r, err = u.Exchange(t.Context(), q)
	if err != nil || len(r.Answer) != 1 || fallbackHits.Load() != 1 {
		t.Fatalf("fallback: %v %v hits=%d", r, err, fallbackHits.Load())
	}
	// With every DoH upstream marked down, the fallback is tried first.
	badHits, goodHits := bad.dohHits.Load(), good.dohHits.Load()
	if _, err := u.Exchange(t.Context(), q); err != nil {
		t.Fatal(err)
	}
	if fallbackHits.Load() != 2 || bad.dohHits.Load() != badHits || good.dohHits.Load() != goodHits {
		t.Fatalf("fallback-first: fb=%d bad=%d good=%d", fallbackHits.Load(), bad.dohHits.Load(), good.dohHits.Load())
	}
}

func TestServeStale(t *testing.T) {
	up := newFakeUpstream(t)
	s := New(t.TempDir(), nil, testLogger())
	defer s.Close()
	s.SetInterfaceSource(func() []netx.Iface { return nil })
	s.Upstreams().Fallback = ""
	st := s.Apply(mustCfg(t, `{"enabled":true,"listen":["127.0.0.1:0"],"upstreams":["`+up.srv.URL+`/dns-query"],"cache":{"enabled":true,"max_ttl_s":1}}`))
	addr := st.Listening[0]
	if r := query(t, "udp", addr, "stale.test", dns.TypeA); len(r.Answer) != 1 {
		t.Fatalf("prime: %v", r)
	}
	up.fail.Store(true)
	time.Sleep(1100 * time.Millisecond)
	r := query(t, "udp", addr, "stale.test", dns.TypeA)
	if r.Rcode != dns.RcodeSuccess || len(r.Answer) != 1 || r.Answer[0].Header().Ttl != StaleTTL {
		t.Fatalf("stale: %v", r)
	}
	if r := query(t, "udp", addr, "never-seen.test", dns.TypeA); r.Rcode != dns.RcodeServerFailure {
		t.Fatalf("uncached: %v", r)
	}
}

func TestPolicyFromCacheWithoutNetwork(t *testing.T) {
	up := newFakeUpstream(t)
	polGz, polSHA := gz(t, "b blocked.test\n")
	up.policies["p1"] = polGz
	dir := t.TempDir()
	cfg := mustCfg(t, `{"enabled":true,"listen":["127.0.0.1:0"],"upstreams":["`+up.srv.URL+`/dns-query"],
	  "default":{"policy":"p1","mode":"enforce"},
	  "policies":{"p1":{"version":"`+polSHA+`","url":"`+up.srv.URL+`/agent/v1/files/p1","sha256":"`+polSHA+`"}}}`)
	s := New(dir, fetch.New(up.srv.URL), testLogger())
	s.SetInterfaceSource(func() []netx.Iface { return nil })
	s.Apply(cfg)
	s.Policies().WaitIdle(5 * time.Second)
	s.Close()

	// "Reboot" with the cloud unreachable: the policy must load from disk
	// synchronously during Apply.
	up.srv.Close()
	s2 := New(dir, fetch.New("https://unreachable.invalid"), testLogger())
	defer s2.Close()
	s2.SetInterfaceSource(func() []netx.Iface { return nil })
	s2.Upstreams().Fallback = ""
	st := s2.Apply(cfg)
	if st.PolicyVersions["p1"] != polSHA {
		t.Fatalf("policy not loaded from cache: %+v", st)
	}
	r := query(t, "udp", st.Listening[0], "www.blocked.test", dns.TypeA)
	if len(r.Answer) != 1 || r.Answer[0].(*dns.A).A.String() != "0.0.0.0" {
		t.Fatalf("not blocked after reboot: %v", r)
	}
	// Upstream down → SERVFAIL for allowed names, but blocking still works.
	r = query(t, "udp", st.Listening[0], "ok.test", dns.TypeA)
	if r.Rcode != dns.RcodeServerFailure {
		t.Fatalf("expected SERVFAIL, got %v", r)
	}
}

func TestParseConfigValidation(t *testing.T) {
	if _, err := ParseConfig(json.RawMessage(`{"clients":`)); err == nil {
		t.Fatal("malformed JSON accepted")
	}
	cfg, err := ParseConfig(json.RawMessage(`{"enabled":true,"block_response":"refused","default":{"mode":"block"},
	  "clients":{"not-an-ip":{"mode":"enforce"},"10.0.0.2":{"mode":"weird"},"10.0.0.3":{"mode":"enforce","policy":null}},
	  "policies":{"../etc/passwd":{"version":"x"},"p_ok":{"version":"y"}},
	  "dot":{"enabled":false,"hostname":null}}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Warnings) != 5 {
		t.Fatalf("warnings %v", cfg.Warnings)
	}
	if cfg.BlockResponse != "null" || cfg.Default.Mode != ModeMonitor || cfg.Clients["10.0.0.2"].Mode != ModeMonitor || cfg.Clients["10.0.0.3"].Mode != ModeEnforce {
		t.Fatalf("sanitised %+v", cfg)
	}
	if _, ok := cfg.Clients["not-an-ip"]; ok {
		t.Fatal("bad client kept")
	}
	if _, ok := cfg.Policies["../etc/passwd"]; ok || len(cfg.Policies) != 1 {
		t.Fatal("unsafe policy kept")
	}
	cfg, err = ParseConfig(json.RawMessage(`{"clients":{"10.0.0.1":{}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Enabled || cfg.Clients["10.0.0.1"].Mode != ModeMonitor || cfg.Cache.MaxEntries != 20000 || !cfg.Log.Enabled || len(cfg.Upstreams) != 2 || len(cfg.Warnings) != 0 {
		t.Fatalf("defaults %+v", cfg)
	}
}

func TestBindFailureKeepsOthers(t *testing.T) {
	busy, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	s := New(t.TempDir(), nil, testLogger())
	defer s.Close()
	s.SetInterfaceSource(func() []netx.Iface { return nil })
	st := s.Apply(mustCfg(t, `{"enabled":true,"listen":["`+busy.LocalAddr().String()+`","127.0.0.1:0"]}`))
	if len(st.Listening) != 1 || len(st.Errors) != 1 {
		t.Fatalf("%+v", st)
	}
}

func TestClientAllowed(t *testing.T) {
	s := New(t.TempDir(), nil, testLogger())
	defer s.Close()
	s.local.Set(netip.MustParsePrefix("2001:db8:20::/64"), netip.MustParsePrefix("192.0.2.0/24"))
	for ip, want := range map[string]bool{
		"10.0.20.31":     true,
		"127.0.0.1":      true,
		"fe80::1":        true,
		"2001:db8:20::9": true,  // global IPv6 on a local subnet
		"192.0.2.77":     true,  // public IPv4 LAN
		"2001:db8:99::9": false, // off-link public
		"8.8.8.8":        false,
	} {
		if got := s.clientAllowed(netip.MustParseAddr(ip)); got != want {
			t.Errorf("%s: %v", ip, got)
		}
	}
}
