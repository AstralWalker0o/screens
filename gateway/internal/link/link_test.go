package link

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/astralwalker0o/screens/gateway/internal/identity"
	"github.com/astralwalker0o/screens/gateway/internal/ops"
	"github.com/astralwalker0o/screens/gateway/internal/proto"
)

type testHub struct {
	srv      *httptest.Server
	attempts atomic.Int32
	status   func(n int32) int // HTTP status to return for attempt n (0 = accept)
	conns    chan *websocket.Conn
	id       *identity.Identity
}

func newTestHub(t *testing.T, id *identity.Identity, status func(n int32) int) *testHub {
	h := &testHub{conns: make(chan *websocket.Conn, 8), status: status, id: id}
	h.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := h.attempts.Add(1)
		if !identity.Verify(id.Key().Public().(ed25519.PublicKey), r.Header) {
			w.WriteHeader(401)
			return
		}
		if s := h.status(n); s != 0 {
			w.WriteHeader(s)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		c.SetReadLimit(1 << 20)
		h.conns <- c
		<-r.Context().Done()
	}))
	t.Cleanup(h.srv.Close)
	return h
}

func readFrame(t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, b, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return m
}

func readUntil(t *testing.T, c *websocket.Conn, pred func(map[string]any) bool) map[string]any {
	t.Helper()
	for i := 0; i < 5000; i++ {
		if m := readFrame(t, c); pred(m) {
			return m
		}
	}
	t.Fatal("frame not found")
	return nil
}

func write(t *testing.T, c *websocket.Conn, v any) {
	b, _ := json.Marshal(v)
	if err := c.Write(context.Background(), websocket.MessageText, b); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func fastTimers(t *testing.T) {
	prev := []time.Duration{BackoffMin, BackoffMax, RevokedWait, IdleTimeout, PingInterval}
	BackoffMin, BackoffMax, RevokedWait = 20*time.Millisecond, 100*time.Millisecond, 2*time.Second
	t.Cleanup(func() {
		BackoffMin, BackoffMax, RevokedWait, IdleTimeout, PingInterval = prev[0], prev[1], prev[2], prev[3], prev[4]
	})
}

func newLink(t *testing.T, h *testHub, reg *ops.Registry) (*Link, context.CancelFunc) {
	l := New(Options{
		CentralURL: h.srv.URL,
		Identity:   h.id,
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		Registry:   reg,
		Hello:      func() any { return map[string]any{"t": "hello", "version": "test"} },
		Workers:    4,
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { l.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	return l, cancel
}

func TestReconnectAfter401(t *testing.T) {
	fastTimers(t)
	id := identity.NewForTest("gw_1")
	h := newTestHub(t, id, func(n int32) int {
		if n <= 2 {
			return 401
		}
		return 0
	})
	newLink(t, h, ops.New())
	select {
	case c := <-h.conns:
		if m := readFrame(t, c); m["t"] != "hello" {
			t.Fatalf("first frame %v", m)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("never connected")
	}
	if n := h.attempts.Load(); n != 3 {
		t.Fatalf("attempts %d", n)
	}
}

func TestRevokedBacksOff(t *testing.T) {
	fastTimers(t)
	id := identity.NewForTest("gw_1")
	h := newTestHub(t, id, func(n int32) int { return 403 })
	newLink(t, h, ops.New())
	time.Sleep(600 * time.Millisecond)
	if n := h.attempts.Load(); n != 1 {
		t.Fatalf("403 must back off for RevokedWait, got %d attempts", n)
	}
}

func TestRequestsAndLimits(t *testing.T) {
	fastTimers(t)
	id := identity.NewForTest("gw_1")
	h := newTestHub(t, id, func(int32) int { return 0 })
	reg := ops.New()
	reg.Register("slow", func(ctx context.Context, _ json.RawMessage) (any, error) {
		<-ctx.Done()
		time.Sleep(50 * time.Millisecond)
		return nil, ctx.Err()
	})
	reg.Register("ignores_ctx", func(ctx context.Context, _ json.RawMessage) (any, error) {
		time.Sleep(2 * time.Second)
		return map[string]any{}, nil
	})
	reg.Register("big", func(ctx context.Context, _ json.RawMessage) (any, error) {
		return map[string]string{"x": strings.Repeat("a", proto.MaxFrame)}, nil
	})
	reg.Register("echo", func(ctx context.Context, a json.RawMessage) (any, error) {
		return map[string]any{"args": a}, nil
	})
	reg.Register("nil", func(ctx context.Context, _ json.RawMessage) (any, error) { return nil, nil })
	l, _ := newLink(t, h, reg)
	c := <-h.conns
	readFrame(t, c) // hello

	write(t, c, map[string]any{"t": "req", "id": "a", "op": "slow", "timeout_ms": 100})
	write(t, c, map[string]any{"t": "req", "id": "b", "op": "ignores_ctx", "timeout_ms": 100})
	write(t, c, map[string]any{"t": "req", "id": "c", "op": "big"})
	write(t, c, map[string]any{"t": "req", "id": "d", "op": "echo", "args": map[string]int{"n": 1}})
	write(t, c, map[string]any{"t": "req", "id": "e", "op": "nil"})
	got := map[string]map[string]any{}
	for len(got) < 5 {
		m := readFrame(t, c)
		if m["t"] == "res" {
			got[m["id"].(string)] = m
		}
	}
	code := func(id string) any {
		e, _ := got[id]["error"].(map[string]any)
		return e["code"]
	}
	if code("a") != "timeout" || code("b") != "timeout" || code("c") != "failed" {
		t.Fatalf("errors: %v", got)
	}
	if got["d"]["ok"] != true || got["d"]["data"].(map[string]any)["args"].(map[string]any)["n"] != float64(1) {
		t.Fatalf("echo %v", got["d"])
	}
	if d, ok := got["e"]["data"].(map[string]any); !ok || len(d) != 0 || got["e"]["ok"] != true {
		t.Fatalf("nil data must be {}: %v", got["e"])
	}

	// Telemetry never blocks: flood the event queue while nothing reads.
	start := time.Now()
	sent := 0
	for i := 0; i < EventQueueLen*4; i++ {
		if l.SendEvent("metrics", map[string]int{"i": i}) {
			sent++
		}
	}
	if time.Since(start) > time.Second {
		t.Fatal("SendEvent blocked")
	}
	if sent == 0 {
		t.Fatal("no events accepted")
	}
	if l.SendEvent("big", strings.Repeat("x", proto.MaxFrame)) {
		t.Fatal("oversized event accepted")
	}
	// Hub ping → pong.
	write(t, c, map[string]any{"t": "ping", "ts": 7})
	if m := readUntil(t, c, func(m map[string]any) bool { return m["t"] == "pong" }); m["ts"] != float64(7) {
		t.Fatalf("pong %v", m)
	}
}

func TestIdleDropAndPing(t *testing.T) {
	fastTimers(t)
	PingInterval = 50 * time.Millisecond
	IdleTimeout = 400 * time.Millisecond
	id := identity.NewForTest("gw_1")
	h := newTestHub(t, id, func(int32) int { return 0 })
	newLink(t, h, ops.New())
	c := <-h.conns
	readFrame(t, c) // hello
	if m := readFrame(t, c); m["t"] != "ping" || m["ts"] == nil {
		t.Fatalf("expected ping, got %v", m)
	}
	// Never answer: the agent must drop the link and reconnect.
	select {
	case c2 := <-h.conns:
		if m := readFrame(t, c2); m["t"] != "hello" {
			t.Fatalf("after reconnect %v", m)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("agent did not reconnect after idle timeout")
	}
}

func TestConnectURL(t *testing.T) {
	cases := map[string]string{
		"https://screens.example.workers.dev":  "wss://screens.example.workers.dev/agent/v1/connect",
		"https://screens.example.workers.dev/": "wss://screens.example.workers.dev/agent/v1/connect",
		"http://127.0.0.1:8787":                "ws://127.0.0.1:8787/agent/v1/connect",
	}
	for in, want := range cases {
		if got := ConnectURL(in); got != want {
			t.Errorf("%s → %s", in, got)
		}
	}
	for i := 0; i < 1000; i++ {
		if j := Jitter(time.Second); j < 800*time.Millisecond || j > 1200*time.Millisecond {
			t.Fatalf("jitter %v", j)
		}
	}
}
