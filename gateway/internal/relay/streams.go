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
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/astralwalker0o/screens/gateway/internal/guard"
	"github.com/astralwalker0o/screens/gateway/internal/ops"
	"github.com/astralwalker0o/screens/gateway/internal/proto"
)

// Tunables.
var (
	// StreamIdleTimeout closes streams with no traffic either way (§5).
	StreamIdleTimeout = 10 * time.Minute
	// MaxDeviceMessage is the largest WebSocket message read from a device.
	MaxDeviceMessage int64 = 4 << 20
	// MaxInboundQueued bounds hub → device bytes waiting per stream.
	MaxInboundQueued int64 = 8 << 20
	// TCPReadChunk is the largest TCP read relayed in one frame (base64
	// keeps the frame well under 512 KiB).
	TCPReadChunk = 128 << 10
)

// Close codes used by the agent.
const (
	CloseNormal      = 1000
	CloseGoingAway   = 1001
	CloseAbnormal    = 1006
	CloseInvalidData = 1007
	CloseTooBig      = 1009
	CloseInternal    = 1011
)

type inbound struct {
	text bool
	data []byte
}

type stream struct {
	id     string
	kind   string // "ws" | "tcp"
	sink   ops.Sink
	m      *Manager
	ws     *websocket.Conn
	tcp    net.Conn
	ctx    context.Context
	cancel context.CancelFunc

	in         chan inbound
	queued     atomic.Int64
	lastActive atomic.Int64
	closed     atomic.Bool
	started    atomic.Bool
}

// Manager owns HTTP clients and open streams.
type Manager struct {
	log     *slog.Logger
	http    *clients
	mu      sync.Mutex
	streams map[string]*stream
	stop    chan struct{}
	wg      sync.WaitGroup
}

// NewManager creates a relay manager and starts the idle janitor.
func NewManager(log *slog.Logger) *Manager {
	m := &Manager{log: log, http: newClients(), streams: map[string]*stream{}, stop: make(chan struct{})}
	m.wg.Add(1)
	go m.janitor()
	return m
}

// Close shuts every stream and stops the janitor.
func (m *Manager) Close() {
	close(m.stop)
	m.wg.Wait()
	m.mu.Lock()
	all := m.streams
	m.streams = map[string]*stream{}
	m.mu.Unlock()
	for _, st := range all {
		st.shutdown(CloseGoingAway, "agent shutting down")
	}
}

// Count returns the number of open streams.
func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.streams)
}

func (m *Manager) janitor() {
	defer m.wg.Done()
	every := StreamIdleTimeout / 20
	if every < 10*time.Millisecond {
		every = 10 * time.Millisecond
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-m.stop:
			return
		case <-t.C:
		}
		cutoff := time.Now().Add(-StreamIdleTimeout).UnixNano()
		var idle []*stream
		m.mu.Lock()
		for _, st := range m.streams {
			if st.lastActive.Load() < cutoff {
				idle = append(idle, st)
			}
		}
		m.mu.Unlock()
		for _, st := range idle {
			m.log.Info("closing idle stream", "stream", st.id)
			st.closeAndNotify(CloseGoingAway, "idle timeout")
		}
	}
}

var streamIDRe = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)

func (m *Manager) register(st *stream) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.streams[st.id]; ok {
		return ops.BadArgs("stream %q already open", st.id)
	}
	m.streams[st.id] = st
	return nil
}

func (m *Manager) remove(st *stream) {
	m.mu.Lock()
	if cur, ok := m.streams[st.id]; ok && cur == st {
		delete(m.streams, st.id)
	}
	m.mu.Unlock()
}

func (m *Manager) get(id string) *stream {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.streams[id]
}

func (st *stream) touch() { st.lastActive.Store(time.Now().UnixNano()) }

// shutdown closes the device side without telling the hub.
func (st *stream) shutdown(code int, reason string) bool {
	if !st.closed.CompareAndSwap(false, true) {
		return false
	}
	st.m.remove(st)
	st.cancel()
	switch st.kind {
	case "ws":
		go func() {
			if code == CloseAbnormal || code < 1000 || code > 4999 {
				code = CloseNormal
			}
			_ = st.ws.Close(websocket.StatusCode(code), truncReason(reason))
		}()
	case "tcp":
		_ = st.tcp.Close()
	}
	return true
}

// closeAndNotify closes the device side and sends a close frame to the hub.
func (st *stream) closeAndNotify(code int, reason string) {
	if !st.shutdown(code, reason) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = st.sink.SendStream(ctx, proto.StreamClose(st.id, code, reason))
}

func truncReason(r string) string {
	if len(r) > 120 {
		return ops.TruncateUTF8(r, 120)
	}
	return r
}

// start launches the device reader and writer. Called after the open res
// has been written, so stream frames never overtake it.
func (st *stream) start() {
	if !st.started.CompareAndSwap(false, true) || st.closed.Load() {
		return
	}
	go st.writeLoop()
	if st.kind == "ws" {
		go st.readWS()
	} else {
		go st.readTCP()
	}
}

func (st *stream) send(f *proto.Stream) bool {
	err := st.sink.SendStream(st.ctx, f)
	if errors.Is(err, proto.ErrFrameTooLarge) {
		st.closeAndNotify(CloseTooBig, "message exceeds frame limit")
		return false
	}
	if err != nil {
		st.shutdown(CloseGoingAway, "link closed")
		return false
	}
	return true
}

func (st *stream) readWS() {
	for {
		typ, b, err := st.ws.Read(st.ctx)
		if err != nil {
			if st.closed.Load() {
				return
			}
			code, reason := CloseAbnormal, err.Error()
			var ce websocket.CloseError
			if errors.As(err, &ce) {
				code, reason = int(ce.Code), ce.Reason
			} else if errors.Is(err, websocket.ErrMessageTooBig) {
				code, reason = CloseTooBig, "message too big"
			}
			st.closeAndNotify(code, reason)
			return
		}
		st.touch()
		var f *proto.Stream
		if typ == websocket.MessageText {
			f = proto.StreamText(st.id, string(b))
		} else {
			f = proto.StreamBinary(st.id, base64.StdEncoding.EncodeToString(b))
		}
		if !st.send(f) {
			return
		}
	}
}

func (st *stream) readTCP() {
	buf := make([]byte, TCPReadChunk)
	for {
		n, err := st.tcp.Read(buf)
		if n > 0 {
			st.touch()
			if !st.send(proto.StreamBinary(st.id, base64.StdEncoding.EncodeToString(buf[:n]))) {
				return
			}
		}
		if err != nil {
			if st.closed.Load() {
				return
			}
			if errors.Is(err, io.EOF) {
				st.closeAndNotify(CloseNormal, "remote closed")
			} else {
				st.closeAndNotify(CloseInternal, err.Error())
			}
			return
		}
	}
}

func (st *stream) writeLoop() {
	for {
		var msg inbound
		select {
		case <-st.ctx.Done():
			return
		case msg = <-st.in:
		}
		st.queued.Add(-int64(len(msg.data)))
		wctx, cancel := context.WithTimeout(st.ctx, 30*time.Second)
		var err error
		if st.kind == "ws" {
			typ := websocket.MessageBinary
			if msg.text {
				typ = websocket.MessageText
			}
			err = st.ws.Write(wctx, typ, msg.data)
		} else {
			if dl, ok := wctx.Deadline(); ok {
				_ = st.tcp.SetWriteDeadline(dl)
			}
			_, err = st.tcp.Write(msg.data)
		}
		cancel()
		if err != nil {
			if !st.closed.Load() {
				st.closeAndNotify(CloseInternal, "write to device: "+err.Error())
			}
			return
		}
		st.touch()
	}
}

// Inbound handles a stream frame from the hub.
func (m *Manager) Inbound(sink ops.Sink, f *proto.Stream) {
	st := m.get(f.Stream)
	if st == nil || st.sink != sink {
		if f.Kind != proto.KindClose {
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_ = sink.SendStream(ctx, proto.StreamClose(f.Stream, CloseInternal, "unknown stream"))
			}()
		}
		return
	}
	var msg inbound
	switch f.Kind {
	case proto.KindClose:
		code := CloseNormal
		if f.Code != nil {
			code = *f.Code
		}
		reason := ""
		if f.Reason != nil {
			reason = *f.Reason
		}
		st.shutdown(code, reason)
		return
	case proto.KindText:
		if st.kind == "tcp" {
			st.closeAndNotify(CloseInvalidData, "tcp streams carry binary only")
			return
		}
		if f.Data != nil {
			msg = inbound{text: true, data: []byte(*f.Data)}
		} else {
			msg = inbound{text: true}
		}
	case proto.KindBinary:
		var b []byte
		if f.DataB64 != nil {
			var err error
			b, err = base64.StdEncoding.DecodeString(*f.DataB64)
			if err != nil {
				st.closeAndNotify(CloseInvalidData, "invalid data_b64")
				return
			}
		}
		msg = inbound{data: b}
	default:
		return
	}
	if st.queued.Add(int64(len(msg.data))) > MaxInboundQueued {
		st.closeAndNotify(CloseInternal, "relay buffer overflow")
		return
	}
	st.touch()
	select {
	case st.in <- msg:
	default:
		st.closeAndNotify(CloseInternal, "relay buffer overflow")
	}
}

// SessionClosed drops every stream bound to a dead session.
func (m *Manager) SessionClosed(sink ops.Sink) {
	m.mu.Lock()
	var dead []*stream
	for _, st := range m.streams {
		if st.sink == sink {
			dead = append(dead, st)
		}
	}
	m.mu.Unlock()
	for _, st := range dead {
		st.shutdown(CloseGoingAway, "link closed")
	}
}

func (m *Manager) newStream(sink ops.Sink, id, kind string) *stream {
	ctx, cancel := context.WithCancel(context.Background())
	st := &stream{id: id, kind: kind, sink: sink, m: m, ctx: ctx, cancel: cancel, in: make(chan inbound, 1024)}
	st.touch()
	return st
}

func (m *Manager) finishOpen(ctx context.Context, st *stream, data any) (any, error) {
	if ctx.Err() != nil {
		st.shutdown(CloseGoingAway, "open timed out")
		return nil, proto.Errf(proto.CodeTimeout, "open timed out")
	}
	if err := m.register(st); err != nil {
		st.shutdown(CloseGoingAway, "duplicate")
		return nil, err
	}
	go func() {
		select {
		case <-st.sink.Done():
			st.shutdown(CloseGoingAway, "link closed")
		case <-st.ctx.Done():
		}
	}()
	return ops.After{Data: data, Fn: st.start}, nil
}

type wsArgs struct {
	Stream       string            `json:"stream"`
	URL          string            `json:"url"`
	Headers      map[string]string `json:"headers"`
	InsecureTLS  *bool             `json:"insecure_tls"`
	Subprotocols []string          `json:"subprotocols"`
}

// WSOpen implements ws.open.
func (m *Manager) WSOpen(ctx context.Context, raw json.RawMessage) (any, error) {
	sink := ops.SinkFrom(ctx)
	if sink == nil {
		return nil, proto.Errf(proto.CodeFailed, "no link session")
	}
	var a wsArgs
	if err := ops.Decode(raw, &a); err != nil {
		return nil, err
	}
	if !streamIDRe.MatchString(a.Stream) {
		return nil, ops.BadArgs("invalid stream id")
	}
	if m.get(a.Stream) != nil {
		return nil, ops.BadArgs("stream %q already open", a.Stream)
	}
	u, err := url.Parse(a.URL)
	if err != nil || (u.Scheme != "ws" && u.Scheme != "wss") || u.Host == "" {
		return nil, ops.BadArgs("url must be ws:// or wss://")
	}
	if _, err := guard.Resolve(ctx, u.Hostname()); err != nil {
		return nil, err
	}
	hdr := http.Header{}
	host := ""
	for k, v := range a.Headers {
		if strings.EqualFold(k, "host") {
			host = v
			continue
		}
		hdr.Set(k, v)
	}
	insecure := a.InsecureTLS == nil || *a.InsecureTLS
	conn, resp, err := websocket.Dial(ctx, a.URL, &websocket.DialOptions{
		HTTPClient:   wsClient(insecure),
		HTTPHeader:   hdr,
		Host:         host,
		Subprotocols: a.Subprotocols,
	})
	if err != nil {
		if resp != nil {
			return nil, proto.Errf(proto.CodeFailed, "websocket handshake: HTTP %d", resp.StatusCode)
		}
		var pe *proto.Error
		if errors.As(err, &pe) {
			return nil, pe
		}
		if ctx.Err() != nil {
			return nil, proto.Errf(proto.CodeTimeout, "%v", err)
		}
		return nil, proto.Errf(proto.CodeUnreachable, "%v", err)
	}
	conn.SetReadLimit(MaxDeviceMessage)
	st := m.newStream(sink, a.Stream, "ws")
	st.ws = conn
	data := map[string]any{}
	if sp := conn.Subprotocol(); sp != "" {
		data["subprotocol"] = sp
	}
	return m.finishOpen(ctx, st, data)
}

type tcpArgs struct {
	Stream string `json:"stream"`
	Host   string `json:"host"`
	Port   int    `json:"port"`
}

// TCPOpen implements tcp.open.
func (m *Manager) TCPOpen(ctx context.Context, raw json.RawMessage) (any, error) {
	sink := ops.SinkFrom(ctx)
	if sink == nil {
		return nil, proto.Errf(proto.CodeFailed, "no link session")
	}
	var a tcpArgs
	if err := ops.Decode(raw, &a); err != nil {
		return nil, err
	}
	if !streamIDRe.MatchString(a.Stream) {
		return nil, ops.BadArgs("invalid stream id")
	}
	if a.Port < 1 || a.Port > 65535 {
		return nil, ops.BadArgs("invalid port")
	}
	if m.get(a.Stream) != nil {
		return nil, ops.BadArgs("stream %q already open", a.Stream)
	}
	c, err := guard.Dialer{Timeout: 10 * time.Second}.DialContext(ctx, "tcp", net.JoinHostPort(strings.Trim(a.Host, "[]"), strconv.Itoa(a.Port)))
	if err != nil {
		return nil, err
	}
	st := m.newStream(sink, a.Stream, "tcp")
	st.tcp = c
	return m.finishOpen(ctx, st, map[string]any{})
}

type closeArgs struct {
	Stream string `json:"stream"`
}

// StreamClose implements stream.close.
func (m *Manager) StreamClose(ctx context.Context, raw json.RawMessage) (any, error) {
	var a closeArgs
	if err := ops.Decode(raw, &a); err != nil {
		return nil, err
	}
	if a.Stream == "" {
		return nil, ops.BadArgs("stream required")
	}
	if st := m.get(a.Stream); st != nil {
		st.shutdown(CloseNormal, "closed by hub")
	}
	return map[string]any{}, nil
}

// Register adds the relay ops to r.
func (m *Manager) Register(r *ops.Registry) {
	r.Register("http.request", m.HTTPRequest)
	r.Register("ws.open", m.WSOpen)
	r.Register("tcp.open", m.TCPOpen)
	r.Register("stream.close", m.StreamClose)
}
