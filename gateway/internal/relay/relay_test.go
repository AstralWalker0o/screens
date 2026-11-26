package relay

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/astralwalker0o/screens/gateway/internal/guard"
	"github.com/astralwalker0o/screens/gateway/internal/ops"
	"github.com/astralwalker0o/screens/gateway/internal/proto"
)

type fakeSink struct {
	frames chan *proto.Stream
	done   chan struct{}
}

func newSink() *fakeSink {
	return &fakeSink{frames: make(chan *proto.Stream, 64), done: make(chan struct{})}
}

func (f *fakeSink) SendStream(ctx context.Context, s *proto.Stream) error {
	b, _ := json.Marshal(s)
	if len(b) > proto.MaxFrame {
		return proto.ErrFrameTooLarge
	}
	select {
	case f.frames <- s:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (f *fakeSink) Done() <-chan struct{} { return f.done }

func (f *fakeSink) next(t *testing.T) *proto.Stream {
	t.Helper()
	select {
	case s := <-f.frames:
		return s
	case <-time.After(5 * time.Second):
		t.Fatal("no stream frame")
		return nil
	}
}

func newMgr(t *testing.T) *Manager {
	m := NewManager(slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(m.Close)
	return m
}

func call(t *testing.T, ctx context.Context, h ops.Handler, args string) (any, error) {
	t.Helper()
	d, err := h(ctx, json.RawMessage(args))
	if a, ok := d.(ops.After); ok {
		a.Fn()
		d = a.Data
	}
	return d, err
}

func errCode(err error) string {
	var pe *proto.Error
	if errors.As(err, &pe) {
		return pe.Code
	}
	if err == nil {
		return ""
	}
	return "?" + err.Error()
}

func TestHTTPRequestForbidden(t *testing.T) {
	m := newMgr(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer srv.Close()
	for _, u := range []string{srv.URL, "http://8.8.8.8/", "http://localhost/", "http://[::1]/"} {
		_, err := m.HTTPRequest(context.Background(), json.RawMessage(`{"url":"`+u+`"}`))
		if errCode(err) != proto.CodeForbidden {
			t.Errorf("%s: %v", u, err)
		}
	}
	_, err := m.HTTPRequest(context.Background(), json.RawMessage(`{"url":"ftp://10.0.0.1/"}`))
	if errCode(err) != proto.CodeBadArgs {
		t.Errorf("ftp: %v", err)
	}
}

func TestHTTPRequest(t *testing.T) {
	defer guard.AllowLoopbackForTesting()()
	m := newMgr(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/text", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		w.Header().Set("X-Method", r.Method)
		w.Header().Set("X-Got", r.Header.Get("X-Test")+"|"+r.Host)
		w.Header().Add("Set-Cookie", "a=1")
		w.Header().Add("Set-Cookie", "b=2")
		_, _ = w.Write([]byte("héllo " + string(b)))
	})
	mux.HandleFunc("/bin", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte{0xff, 0x00, 0xfe}) })
	mux.HandleFunc("/big", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(strings.Repeat("a", 5000))) })
	mux.HandleFunc("/huge", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(strings.Repeat("\x01", 1<<20))) })
	mux.HandleFunc("/redirect", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/text", http.StatusFound) })
	mux.HandleFunc("/slow", func(w http.ResponseWriter, r *http.Request) { time.Sleep(2 * time.Second) })
	srv := httptest.NewServer(mux)
	defer srv.Close()
	tls := httptest.NewTLSServer(mux)
	defer tls.Close()

	d, err := call(t, context.Background(), m.HTTPRequest, `{"url":"`+srv.URL+`/text","method":"post","headers":{"X-Test":"1","Host":"tv.local"},"body":"world"}`)
	if err != nil {
		t.Fatal(err)
	}
	r := d.(HTTPResult)
	if r.Status != 200 || r.Body == nil || *r.Body != "héllo world" || r.BodyB64 != nil || r.Truncated {
		t.Fatalf("%+v", r)
	}
	if r.Headers["x-method"] != "POST" || r.Headers["x-got"] != "1|tv.local" || r.Headers["set-cookie"] != "a=1, b=2" {
		t.Fatalf("headers %v", r.Headers)
	}
	d, _ = call(t, context.Background(), m.HTTPRequest, `{"url":"`+srv.URL+`/text","method":"PUT","body_b64":"`+base64.StdEncoding.EncodeToString([]byte("b64"))+`"}`)
	if r := d.(HTTPResult); *r.Body != "héllo b64" {
		t.Fatalf("%+v", r)
	}
	d, _ = call(t, context.Background(), m.HTTPRequest, `{"url":"`+srv.URL+`/bin"}`)
	if r := d.(HTTPResult); r.Body != nil || r.BodyB64 == nil || *r.BodyB64 != "/wD+" {
		t.Fatalf("binary %+v", r)
	}
	d, _ = call(t, context.Background(), m.HTTPRequest, `{"url":"`+srv.URL+`/big","max_body":100}`)
	if r := d.(HTTPResult); !r.Truncated || len(*r.Body) != 100 {
		t.Fatalf("truncated %+v", r)
	}
	// A body whose JSON encoding would not fit in a frame is shrunk.
	d, _ = call(t, context.Background(), m.HTTPRequest, `{"url":"`+srv.URL+`/huge"}`)
	if r := d.(HTTPResult); !r.Truncated || proto.FrameSize(r) > proto.FrameBudget {
		t.Fatalf("huge not fitted: truncated=%v size=%d", r.Truncated, proto.FrameSize(r))
	}
	// Redirects are returned, not followed, unless asked.
	d, _ = call(t, context.Background(), m.HTTPRequest, `{"url":"`+srv.URL+`/redirect"}`)
	if r := d.(HTTPResult); r.Status != 302 || r.Headers["location"] != "/text" {
		t.Fatalf("redirect %+v", r)
	}
	d, _ = call(t, context.Background(), m.HTTPRequest, `{"url":"`+srv.URL+`/redirect","follow_redirects":true}`)
	if r := d.(HTTPResult); r.Status != 200 {
		t.Fatalf("follow %+v", r)
	}
	// Self-signed TLS: default insecure_tls=true works; false fails.
	d, err = call(t, context.Background(), m.HTTPRequest, `{"url":"`+tls.URL+`/bin"}`)
	if err != nil || d.(HTTPResult).Status != 200 {
		t.Fatalf("insecure tls: %v", err)
	}
	if _, err = call(t, context.Background(), m.HTTPRequest, `{"url":"`+tls.URL+`/bin","insecure_tls":false}`); errCode(err) != proto.CodeFailed {
		t.Fatalf("verified tls should fail: %v", err)
	}
	// Timeout.
	if _, err = call(t, context.Background(), m.HTTPRequest, `{"url":"`+srv.URL+`/slow","timeout_ms":100}`); errCode(err) != proto.CodeTimeout {
		t.Fatalf("timeout: %v", err)
	}
	// Unreachable (closed port).
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close()
	if _, err = call(t, context.Background(), m.HTTPRequest, `{"url":"http://`+addr+`/"}`); errCode(err) != proto.CodeUnreachable {
		t.Fatalf("unreachable: %v", err)
	}
}

func echoWS(t *testing.T) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"lg"}})
		if err != nil {
			return
		}
		defer c.CloseNow()
		_ = c.Write(r.Context(), websocket.MessageText, []byte(`{"event":"ms.channel.connect","q":"`+r.URL.Query().Get("name")+`"}`))
		for {
			typ, b, err := c.Read(r.Context())
			if err != nil {
				return
			}
			if string(b) == "bye" {
				c.Close(4000, "see you")
				return
			}
			_ = c.Write(r.Context(), typ, append([]byte("echo:"), b...))
		}
	}))
}

func TestWSStream(t *testing.T) {
	defer guard.AllowLoopbackForTesting()()
	m := newMgr(t)
	srv := echoWS(t)
	defer srv.Close()
	sink := newSink()
	ctx := ops.WithSink(context.Background(), sink)
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/v2/channels/samsung.remote.control?name=U2NyZWVucw=="
	d, err := call(t, ctx, m.WSOpen, `{"stream":"s_1","url":"`+wsURL+`","subprotocols":["lg"]}`)
	if err != nil {
		t.Fatal(err)
	}
	if d.(map[string]any)["subprotocol"] != "lg" {
		t.Fatalf("data %v", d)
	}
	f := sink.next(t)
	if f.Kind != "text" || !strings.Contains(*f.Data, "ms.channel.connect") || !strings.Contains(*f.Data, "U2NyZWVucw==") {
		t.Fatalf("first frame %+v", f)
	}
	m.Inbound(sink, proto.StreamText("s_1", `{"method":"ms.remote.control"}`))
	if f := sink.next(t); f.Kind != "text" || *f.Data != `echo:{"method":"ms.remote.control"}` {
		t.Fatalf("echo %+v", f)
	}
	m.Inbound(sink, proto.StreamBinary("s_1", base64.StdEncoding.EncodeToString([]byte{1, 2})))
	if f := sink.next(t); f.Kind != "binary" || *f.DataB64 != base64.StdEncoding.EncodeToString([]byte("echo:\x01\x02")) {
		t.Fatalf("binary echo %+v", f)
	}
	// Duplicate stream id.
	if _, err := call(t, ctx, m.WSOpen, `{"stream":"s_1","url":"`+wsURL+`"}`); errCode(err) != proto.CodeBadArgs {
		t.Fatalf("dup: %v", err)
	}
	// Remote close is reported with its code.
	m.Inbound(sink, proto.StreamText("s_1", "bye"))
	if f := sink.next(t); f.Kind != "close" || *f.Code != 4000 || *f.Reason != "see you" {
		t.Fatalf("close %+v", f)
	}
	waitCount(t, m, 0)
	// Unknown stream → close frame.
	m.Inbound(sink, proto.StreamText("s_404", "x"))
	if f := sink.next(t); f.Kind != "close" || f.Stream != "s_404" {
		t.Fatalf("unknown %+v", f)
	}
	// Hub-initiated close and stream.close.
	if _, err := call(t, ctx, m.WSOpen, `{"stream":"s_2","url":"`+wsURL+`"}`); err != nil {
		t.Fatal(err)
	}
	sink.next(t)
	if _, err := call(t, ctx, m.StreamClose, `{"stream":"s_2"}`); err != nil {
		t.Fatal(err)
	}
	waitCount(t, m, 0)
	// Forbidden target.
	if _, err := call(t, context.Background(), m.WSOpen, `{"stream":"s_3","url":"wss://8.8.8.8/"}`); errCode(err) == "" {
		t.Fatal("no sink should fail")
	}
	if _, err := call(t, ctx, m.WSOpen, `{"stream":"s_3","url":"wss://8.8.8.8/"}`); errCode(err) != proto.CodeForbidden {
		t.Fatalf("forbidden: %v", err)
	}
}

func waitCount(t *testing.T, m *Manager, n int) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if m.Count() == n {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("stream count %d, want %d", m.Count(), n)
}

func TestTCPStreamAndIdle(t *testing.T) {
	defer guard.AllowLoopbackForTesting()()
	prev := StreamIdleTimeout
	StreamIdleTimeout = 300 * time.Millisecond
	defer func() { StreamIdleTimeout = prev }()
	m := newMgr(t)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				buf := make([]byte, 100)
				n, _ := c.Read(buf)
				_, _ = c.Write(append([]byte("ack:"), buf[:n]...))
				if string(buf[:n]) == "quit" {
					c.Close()
				}
			}()
		}
	}()
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	sink := newSink()
	ctx := ops.WithSink(context.Background(), sink)
	if _, err := call(t, ctx, m.TCPOpen, `{"stream":"t1","host":"127.0.0.1","port":`+port+`}`); err != nil {
		t.Fatal(err)
	}
	m.Inbound(sink, proto.StreamBinary("t1", base64.StdEncoding.EncodeToString([]byte("quit"))))
	f := sink.next(t)
	if b, _ := base64.StdEncoding.DecodeString(*f.DataB64); string(b) != "ack:quit" {
		t.Fatalf("tcp data %+v", f)
	}
	if f := sink.next(t); f.Kind != "close" || *f.Code != CloseNormal {
		t.Fatalf("tcp close %+v", f)
	}
	// Idle stream is closed with a notification.
	if _, err := call(t, ctx, m.TCPOpen, `{"stream":"t2","host":"127.0.0.1","port":`+port+`}`); err != nil {
		t.Fatal(err)
	}
	if f := sink.next(t); f.Kind != "close" || *f.Code != CloseGoingAway || *f.Reason != "idle timeout" {
		t.Fatalf("idle close %+v", f)
	}
	// Text on a TCP stream is rejected.
	if _, err := call(t, ctx, m.TCPOpen, `{"stream":"t3","host":"127.0.0.1","port":`+port+`}`); err != nil {
		t.Fatal(err)
	}
	m.Inbound(sink, proto.StreamText("t3", "x"))
	if f := sink.next(t); f.Kind != "close" || *f.Code != CloseInvalidData {
		t.Fatalf("text on tcp %+v", f)
	}
	// Session end drops streams silently.
	if _, err := call(t, ctx, m.TCPOpen, `{"stream":"t4","host":"127.0.0.1","port":`+port+`}`); err != nil {
		t.Fatal(err)
	}
	m.SessionClosed(sink)
	waitCount(t, m, 0)
	// Forbidden / unreachable.
	if _, err := call(t, ctx, m.TCPOpen, `{"stream":"t5","host":"8.8.8.8","port":53}`); errCode(err) != proto.CodeForbidden {
		t.Fatalf("forbidden: %v", err)
	}
}

func TestInsecureTLSConfig(t *testing.T) {
	c := InsecureTLS()
	if !c.InsecureSkipVerify || c.MinVersion != 0x0301 || len(c.CipherSuites) == 0 {
		t.Fatal("insecure tls config")
	}
}

func TestAsText(t *testing.T) {
	if s, ok := asText([]byte("h\xc3"), true); !ok || s != "h" {
		t.Fatal("cut rune at truncation should be text")
	}
	if _, ok := asText([]byte("h\xc3"), false); ok {
		t.Fatal("invalid utf8 must be binary")
	}
	if _, ok := asText([]byte{0xff, 'a', 'b', 'c', 'd'}, true); ok {
		t.Fatal("binary")
	}
}
