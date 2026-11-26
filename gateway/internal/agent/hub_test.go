package agent

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/miekg/dns"

	"github.com/astralwalker0o/screens/gateway/internal/guard"
	"github.com/astralwalker0o/screens/gateway/internal/identity"
	"github.com/astralwalker0o/screens/gateway/internal/logbuf"
)

// fakeHub implements the central side of PROTOCOL.md §1–3: enrollment,
// signed connect verification and a frame router for the test.
type fakeHub struct {
	t        *testing.T
	srv      *httptest.Server
	mu       sync.Mutex
	pub      ed25519.PublicKey
	nonces   map[string]bool
	connects atomic.Int32
	rejected atomic.Int32
	files    map[string][]byte
	conns    chan *hubConn
}

type hubConn struct {
	t      *testing.T
	c      *websocket.Conn
	hdr    http.Header
	hello  chan map[string]any
	evts   chan map[string]any
	stream chan map[string]any
	pongs  chan map[string]any
	mu     sync.Mutex
	res    map[string]chan map[string]any
	nextID atomic.Int64
	done   chan struct{}
}

func newFakeHub(t *testing.T) *fakeHub {
	h := &fakeHub{t: t, nonces: map[string]bool{}, files: map[string][]byte{}, conns: make(chan *hubConn, 4)}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /agent/v1/enroll", func(w http.ResponseWriter, r *http.Request) {
		var req identity.EnrollRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(400)
			return
		}
		if req.Token != "enr_test" {
			w.WriteHeader(http.StatusGone)
			_, _ = w.Write([]byte(`{"error":"token_invalid","message":"used or expired"}`))
			return
		}
		raw, err := identity.DecodeB64URL(req.PublicKey)
		if err != nil || len(raw) != ed25519.PublicKeySize || req.OS == "" || req.Arch == "" || req.Version == "" {
			w.WriteHeader(400)
			return
		}
		h.mu.Lock()
		h.pub = raw
		h.mu.Unlock()
		_, _ = w.Write([]byte(`{"site_id":"site_abc","site_name":"Beach House","gateway_id":"gw_xyz"}`))
	})
	mux.HandleFunc("GET /agent/v1/connect", func(w http.ResponseWriter, r *http.Request) {
		h.connects.Add(1)
		if code := h.verify(r.Header); code != 0 {
			h.rejected.Add(1)
			w.WriteHeader(code)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		c.SetReadLimit(1 << 20)
		hc := &hubConn{t: t, c: c, hdr: r.Header.Clone(), hello: make(chan map[string]any, 1), evts: make(chan map[string]any, 256), stream: make(chan map[string]any, 64), pongs: make(chan map[string]any, 8), res: map[string]chan map[string]any{}, done: make(chan struct{})}
		h.conns <- hc
		hc.readLoop(r.Context())
	})
	mux.HandleFunc("GET /agent/v1/files/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("sig") == "" {
			w.WriteHeader(403)
			return
		}
		b, ok := h.files[strings.TrimPrefix(r.URL.Path, "/agent/v1/files/")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(b)
	})
	h.srv = httptest.NewServer(mux)
	t.Cleanup(h.srv.Close)
	return h
}

// verify implements the Worker's checks (§2). It returns 0 if OK.
func (h *fakeHub) verify(hdr http.Header) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.pub == nil || hdr.Get("X-Screens-Gateway") != "gw_xyz" {
		return 401
	}
	ts, err := strconv.ParseInt(hdr.Get("X-Screens-Ts"), 10, 64)
	if err != nil {
		return 401
	}
	if d := time.Now().UnixMilli() - ts; d > 300000 || d < -300000 {
		return 401
	}
	nonce := hdr.Get("X-Screens-Nonce")
	if nb, err := identity.DecodeB64URL(nonce); err != nil || len(nb) != 16 || h.nonces[nonce] {
		return 401
	}
	if !identity.Verify(h.pub, hdr) {
		return 401
	}
	h.nonces[nonce] = true
	return 0
}

func (hc *hubConn) readLoop(ctx context.Context) {
	defer close(hc.done)
	for {
		_, b, err := hc.c.Read(ctx)
		if err != nil {
			return
		}
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			hc.t.Errorf("hub got non-JSON frame: %q", b)
			continue
		}
		if len(b) > 512*1024 {
			hc.t.Errorf("frame of %d bytes exceeds 512 KiB", len(b))
		}
		switch m["t"] {
		case "hello":
			hc.hello <- m
		case "evt":
			select {
			case hc.evts <- m:
			default:
			}
		case "stream":
			hc.stream <- m
		case "pong":
			hc.pongs <- m
		case "ping":
			hc.send(map[string]any{"t": "pong", "ts": m["ts"]})
		case "res":
			id, _ := m["id"].(string)
			hc.mu.Lock()
			ch := hc.res[id]
			hc.mu.Unlock()
			if ch != nil {
				ch <- m
			} else {
				hc.t.Errorf("unexpected res %v", m)
			}
		default:
			hc.t.Errorf("unexpected frame %v", m)
		}
	}
}

func (hc *hubConn) send(v any) {
	b, _ := json.Marshal(v)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := hc.c.Write(ctx, websocket.MessageText, b); err != nil {
		hc.t.Errorf("hub write: %v", err)
	}
}

// call sends a req and waits for its res.
func (hc *hubConn) call(op string, args any, timeout time.Duration) map[string]any {
	hc.t.Helper()
	id := "r_" + strconv.FormatInt(hc.nextID.Add(1), 10)
	ch := make(chan map[string]any, 1)
	hc.mu.Lock()
	hc.res[id] = ch
	hc.mu.Unlock()
	hc.send(map[string]any{"t": "req", "id": id, "op": op, "args": args, "timeout_ms": timeout.Milliseconds()})
	select {
	case r := <-ch:
		return r
	case <-time.After(timeout + 5*time.Second):
		hc.t.Fatalf("no res for %s (%s)", id, op)
		return nil
	}
}

func okData(t *testing.T, res map[string]any) map[string]any {
	t.Helper()
	if res["ok"] != true {
		t.Fatalf("res not ok: %v", res)
	}
	d, _ := res["data"].(map[string]any)
	return d
}

func waitEvt(t *testing.T, hc *hubConn, typ string, pred func(map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case e := <-hc.evts:
			if e["type"] == typ {
				d, _ := e["data"].(map[string]any)
				if pred == nil || pred(d) {
					return d
				}
			}
		case <-deadline:
			t.Fatalf("no %s event", typ)
			return nil
		}
	}
}

// fakeDoH answers A queries with 93.184.216.34.
func fakeDoH(t *testing.T) *httptest.Server {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		q := new(dns.Msg)
		if err := q.Unpack(body); err != nil {
			w.WriteHeader(400)
			return
		}
		resp := new(dns.Msg)
		resp.SetReply(q)
		if q.Question[0].Qtype == dns.TypeA {
			resp.Answer = []dns.RR{&dns.A{Hdr: dns.RR_Header{Name: q.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60}, A: net.ParseIP("93.184.216.34")}}
		}
		out, _ := resp.Pack()
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(out)
	}))
	t.Cleanup(s.Close)
	return s
}

func TestAgentAgainstFakeHub(t *testing.T) {
	defer guard.AllowLoopbackForTesting()()
	hub := newFakeHub(t)
	doh := fakeDoH(t)

	// Policy file served via a signed URL on the hub origin.
	var pg bytes.Buffer
	zw := gzip.NewWriter(&pg)
	_, _ = zw.Write([]byte("# screens-policy v1 id=p_test\nb ads.test ads\n"))
	zw.Close()
	hub.files["p_test"] = pg.Bytes()
	sum := sha256.Sum256(pg.Bytes())
	polSHA := hex.EncodeToString(sum[:])

	// A "LAN" HTTP device and a WebSocket device.
	lan := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"device":{"name":"[TV] Samsung","path":"` + r.URL.Path + `"}}`))
	}))
	defer lan.Close()
	wsDev := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		_ = c.Write(r.Context(), websocket.MessageText, []byte(`{"event":"ms.channel.connect"}`))
		for {
			typ, b, err := c.Read(r.Context())
			if err != nil {
				return
			}
			_ = c.Write(r.Context(), typ, append([]byte("echo:"), b...))
		}
	}))
	defer wsDev.Close()

	dir := t.TempDir()
	ring := logbuf.NewRing(500)
	h := logbuf.New(io.Discard, ring, nil)
	var exitCode atomic.Int32
	exitCode.Store(-1)
	a := New(Options{
		CentralURL:  hub.srv.URL,
		EnrollToken: "enr_test",
		DataDir:     dir,
		Version:     "0.1.0-test",
		Logger:      slog.New(h),
		Handler:     h,
		Ring:        ring,
		Exit:        func(code int) { exitCode.Store(int32(code)) },
	})
	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() { _ = a.Run(ctx); close(runDone) }()
	defer func() {
		cancel()
		select {
		case <-runDone:
		case <-time.After(10 * time.Second):
			t.Error("agent did not stop")
		}
	}()

	var hc *hubConn
	select {
	case hc = <-hub.conns:
	case <-time.After(10 * time.Second):
		t.Fatal("agent never connected")
	}

	// Enrollment wrote the identity with mode 0600 and the key the hub has.
	st, err := os.Stat(filepath.Join(dir, "identity.json"))
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("identity.json: %v %v", st, err)
	}
	id, err := identity.Load(dir)
	if err != nil || id.GatewayID != "gw_xyz" || id.SiteID != "site_abc" || id.CentralURL != hub.srv.URL {
		t.Fatalf("identity %+v %v", id, err)
	}
	if !ed25519.PublicKey(hub.pub).Equal(id.Key().Public()) {
		t.Fatal("hub holds a different key")
	}
	// Connect headers verify with ed25519.
	if !identity.Verify(hub.pub, hc.hdr) {
		t.Fatal("connect signature does not verify")
	}

	// hello is the first frame.
	var hello map[string]any
	select {
	case hello = <-hc.hello:
	case <-time.After(5 * time.Second):
		t.Fatal("no hello")
	}
	if hello["version"] != "0.1.0-test" || hello["os"] == "" || hello["arch"] == "" || hello["started_at"] == nil {
		t.Fatalf("hello %v", hello)
	}
	caps := map[string]bool{}
	for _, c := range hello["caps"].([]any) {
		caps[c.(string)] = true
	}
	for _, c := range []string{"dns", "http", "ws", "tcp", "mdns", "update"} {
		if !caps[c] {
			t.Errorf("cap %s missing: %v", c, hello["caps"])
		}
	}
	if _, ok := hello["interfaces"].([]any); !ok {
		t.Fatalf("hello.interfaces %v", hello["interfaces"])
	}

	dnsCfg := map[string]any{
		"enabled":        true,
		"listen":         []string{"127.0.0.1:0"},
		"upstreams":      []string{doh.URL + "/dns-query"},
		"block_response": "null",
		"cache":          map[string]any{"enabled": true, "max_entries": 1000},
		"default":        map[string]any{"policy": "", "mode": "monitor"},
		"clients": map[string]any{
			"127.0.0.1": map[string]any{"device_id": "dev_1", "policy": "p_test", "mode": "enforce", "allow": []string{}, "block": []string{"blocked.test"}},
		},
		"policies": map[string]any{
			"p_test": map[string]any{"version": polSHA, "sha256": polSHA, "url": hub.srv.URL + "/agent/v1/files/p_test?exp=9999999999999&sig=abc"},
		},
		"log": map[string]any{"enabled": true},
	}
	hc.send(map[string]any{
		"t": "welcome", "site_id": "site_abc", "server_time": time.Now().UnixMilli(),
		"config": map[string]any{
			"dns":       dnsCfg,
			"mdns":      map[string]any{"enabled": false},
			"telemetry": map[string]any{"dns_batch_ms": 200, "metrics_ms": 60000, "neighbors_ms": 300000},
		},
	})

	// Hub ping → agent pong.
	hc.send(map[string]any{"t": "ping", "ts": 42})
	select {
	case p := <-hc.pongs:
		if p["ts"] != float64(42) {
			t.Fatalf("pong %v", p)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no pong")
	}

	// sys.info
	info := okData(t, hc.call("sys.info", nil, 5*time.Second))
	if info["version"] != "0.1.0-test" || info["go_version"] == "" || info["mem"] == nil || info["load"] == nil {
		t.Fatalf("sys.info %v", info)
	}

	// Unknown op.
	if r := hc.call("nope.nope", nil, 5*time.Second); r["ok"] != false || r["error"].(map[string]any)["code"] != "unknown_op" {
		t.Fatalf("unknown op %v", r)
	}

	// http.request against the LAN server.
	hr := okData(t, hc.call("http.request", map[string]any{"url": lan.URL + "/api/v2/", "insecure_tls": true}, 10*time.Second))
	if hr["status"] != float64(200) || !strings.Contains(hr["body"].(string), `"[TV] Samsung"`) || hr["truncated"] != false {
		t.Fatalf("http.request %v", hr)
	}
	// Public targets are refused even with the test hook.
	if r := hc.call("http.request", map[string]any{"url": "http://8.8.8.8/"}, 5*time.Second); r["error"].(map[string]any)["code"] != "forbidden" {
		t.Fatalf("forbidden %v", r)
	}

	// dns.configure (same config as welcome) reports the bound listener.
	dr := okData(t, hc.call("dns.configure", dnsCfg, 10*time.Second))
	listening := dr["listening"].([]any)
	if len(listening) != 1 {
		t.Fatalf("dns.configure %v", dr)
	}
	addr := listening[0].(string)
	// Wait for the policy download.
	deadline := time.Now().Add(5 * time.Second)
	for {
		if v, _ := a.dns.Policies().Versions()["p_test"]; v == polSHA {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("policy not downloaded")
		}
		time.Sleep(20 * time.Millisecond)
	}
	q := func(name string) *dns.Msg {
		c := &dns.Client{Timeout: 3 * time.Second}
		m := new(dns.Msg)
		m.SetQuestion(dns.Fqdn(name), dns.TypeA)
		r, _, err := c.Exchange(m, addr)
		if err != nil {
			t.Fatalf("query %s: %v", name, err)
		}
		return r
	}
	if r := q("www.blocked.test"); len(r.Answer) != 1 || r.Answer[0].(*dns.A).A.String() != "0.0.0.0" {
		t.Fatalf("inline block: %v", r)
	}
	if r := q("tracker.ads.test"); len(r.Answer) != 1 || r.Answer[0].(*dns.A).A.String() != "0.0.0.0" {
		t.Fatalf("policy block: %v", r)
	}
	if r := q("allowed.test"); len(r.Answer) != 1 || r.Answer[0].(*dns.A).A.String() != "93.184.216.34" {
		t.Fatalf("allowed: %v", r)
	}
	seen := map[string]map[string]any{}
	waitEvt(t, hc, "dns.queries", func(d map[string]any) bool {
		for _, e := range d["entries"].([]any) {
			em := e.(map[string]any)
			seen[em["qname"].(string)] = em
		}
		return len(seen) >= 3
	})
	if e := seen["www.blocked.test"]; e["action"] != "block" || e["rule"] != "client_block" || e["device_id"] != "dev_1" || e["client"] != "127.0.0.1" || e["proto"] != "udp" {
		t.Fatalf("blocked entry %v", e)
	}
	if e := seen["tracker.ads.test"]; e["action"] != "block" || e["rule"] != "ads.test" || e["cat"] != "ads" {
		t.Fatalf("policy entry %v", e)
	}
	if e := seen["allowed.test"]; e["action"] != "allow" || e["rcode"] != "NOERROR" || len(e["answers"].([]any)) != 1 {
		t.Fatalf("allowed entry %v", e)
	}
	stats := okData(t, hc.call("dns.stats", nil, 5*time.Second))
	if stats["blocked"] != float64(2) || stats["queries"] != float64(3) {
		t.Fatalf("dns.stats %v", stats)
	}

	// The config was persisted for offline restarts.
	pb, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil || !strings.Contains(string(pb), "blocked.test") || !strings.Contains(string(pb), `"dns_batch_ms":200`) {
		t.Fatalf("config.json: %s %v", pb, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "dns", "p_test.gz")); err != nil {
		t.Fatalf("policy not cached: %v", err)
	}

	// ws.open relays text both ways.
	wsURL := "ws" + strings.TrimPrefix(wsDev.URL, "http") + "/api/v2/channels/samsung.remote.control?name=U2NyZWVucw%3D%3D"
	okData(t, hc.call("ws.open", map[string]any{"stream": "s_1", "url": wsURL, "insecure_tls": true}, 10*time.Second))
	nextStream := func() map[string]any {
		select {
		case f := <-hc.stream:
			return f
		case <-time.After(5 * time.Second):
			t.Fatal("no stream frame")
			return nil
		}
	}
	if f := nextStream(); f["stream"] != "s_1" || f["kind"] != "text" || f["data"] != `{"event":"ms.channel.connect"}` {
		t.Fatalf("device → hub %v", f)
	}
	hc.send(map[string]any{"t": "stream", "stream": "s_1", "kind": "text", "data": `{"method":"ms.remote.control","params":{"DataOfCmd":"KEY_HOME"}}`})
	if f := nextStream(); f["data"] != `echo:{"method":"ms.remote.control","params":{"DataOfCmd":"KEY_HOME"}}` {
		t.Fatalf("hub → device → hub %v", f)
	}
	hc.send(map[string]any{"t": "stream", "stream": "s_1", "kind": "binary", "data_b64": "AAEC"})
	if f := nextStream(); f["kind"] != "binary" || f["data_b64"] != "ZWNobzoAAQI=" {
		t.Fatalf("binary %v", f)
	}
	okData(t, hc.call("stream.close", map[string]any{"stream": "s_1"}, 5*time.Second))
	// A frame for a now-unknown stream is answered with close.
	hc.send(map[string]any{"t": "stream", "stream": "s_1", "kind": "text", "data": "x"})
	if f := nextStream(); f["kind"] != "close" || f["stream"] != "s_1" {
		t.Fatalf("unknown stream %v", f)
	}

	// sys.logs returns ring-buffer lines.
	logs := okData(t, hc.call("sys.logs", map[string]any{"lines": 50}, 5*time.Second))
	if ls := logs["lines"].([]any); len(ls) == 0 || len(ls) > 50 {
		t.Fatalf("sys.logs %d lines", len(ls))
	}

	// Concurrency: a slow request does not block a fast one.
	slowDone := make(chan map[string]any, 1)
	go func() {
		slowDone <- hc.call("http.request", map[string]any{"url": "http://" + blackhole(t) + "/", "timeout_ms": 1500}, 5*time.Second)
	}()
	time.Sleep(100 * time.Millisecond)
	start := time.Now()
	okData(t, hc.call("dns.stats", nil, 5*time.Second))
	if time.Since(start) > time.Second {
		t.Fatal("fast request waited for the slow one")
	}
	if r := <-slowDone; r["ok"] != false {
		t.Fatalf("slow request %v", r)
	}

	if hub.rejected.Load() != 0 {
		t.Fatalf("hub rejected %d connects", hub.rejected.Load())
	}
}

// blackhole returns a loopback address that accepts TCP but never answers HTTP.
func blackhole(t *testing.T) string {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { time.Sleep(5 * time.Second); c.Close() }()
		}
	}()
	return ln.Addr().String()
}

func TestOfflineStartFromPersistedConfig(t *testing.T) {
	// No identity, no central URL: DNS must still come up from config.json.
	doh := fakeDoH(t)
	dir := t.TempDir()
	cfg := `{"dns":{"enabled":true,"listen":["127.0.0.1:0"],"upstreams":["` + doh.URL + `/dns-query"],"clients":{"127.0.0.1":{"mode":"enforce","block":["blocked.test"]}}}}`
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	a := New(Options{DataDir: dir, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), EnrollRetry: time.Hour})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = a.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()
	var addr string
	for i := 0; i < 100; i++ {
		if a.dns != nil {
			if st := a.dns.Status(); len(st.Listening) == 1 {
				addr = st.Listening[0]
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if addr == "" {
		t.Fatal("dns did not start from persisted config")
	}
	c := &dns.Client{Timeout: 3 * time.Second}
	m := new(dns.Msg)
	m.SetQuestion("blocked.test.", dns.TypeA)
	r, _, err := c.Exchange(m, addr)
	if err != nil || len(r.Answer) != 1 || r.Answer[0].(*dns.A).A.String() != "0.0.0.0" {
		t.Fatalf("offline block: %v %v", r, err)
	}
}

func TestEnrollRejectedRetries(t *testing.T) {
	hub := newFakeHub(t)
	dir := t.TempDir()
	a := New(Options{CentralURL: hub.srv.URL, EnrollToken: "enr_expired", DataDir: dir, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), EnrollRetry: 50 * time.Millisecond})
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	_ = a.Run(ctx)
	if _, err := os.Stat(filepath.Join(dir, "identity.json")); !os.IsNotExist(err) {
		t.Fatal("identity written for rejected token")
	}
}

func TestSysRestartExits(t *testing.T) {
	hub := newFakeHub(t)
	dir := t.TempDir()
	exited := make(chan int, 1)
	a := New(Options{CentralURL: hub.srv.URL, EnrollToken: "enr_test", DataDir: dir, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Exit: func(c int) {
		select {
		case exited <- c:
		default:
		}
	}})
	done := make(chan struct{})
	go func() { _ = a.Run(context.Background()); close(done) }()
	hc := <-hub.conns
	<-hc.hello
	r := hc.call("sys.restart", nil, 5*time.Second)
	if r["ok"] != true {
		t.Fatalf("restart res %v", r)
	}
	select {
	case c := <-exited:
		if c != 0 {
			t.Fatalf("exit code %d", c)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("did not exit")
	}
	<-done
}
