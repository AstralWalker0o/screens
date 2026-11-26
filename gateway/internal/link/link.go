// Package link maintains the agent's WebSocket to the SiteHub
// (PROTOCOL.md §2–3): signed connect, hello/welcome, concurrent req
// handling on a bounded worker pool, ping/pong and liveness, reconnect with
// backoff and jitter, and prioritised bounded send queues (res is never
// dropped; telemetry is dropped when the link is congested).
package link

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/astralwalker0o/screens/gateway/internal/identity"
	"github.com/astralwalker0o/screens/gateway/internal/ops"
	"github.com/astralwalker0o/screens/gateway/internal/proto"
)

// Timing constants (§2, §3). Variables so tests can shorten them.
var (
	PingInterval  = 25 * time.Second
	IdleTimeout   = 90 * time.Second
	BackoffMin    = time.Second
	BackoffMax    = 60 * time.Second
	BackoffReset  = 60 * time.Second
	RevokedWait   = 10 * time.Minute
	WriteTimeout  = 30 * time.Second
	DialTimeout   = 30 * time.Second
	DefaultReqMs  = int64(30000)
	MaxReqMs      = int64(600000)
	ReadLimit     = int64(1 << 20)
	PrioQueueLen  = 256
	StreamQueue   = 256
	EventQueueLen = 128
	JobQueueLen   = 512
)

// StreamRouter receives inbound stream frames.
type StreamRouter interface {
	Inbound(s ops.Sink, f *proto.Stream)
	InboundBytes(s ops.Sink, id string, data []byte)
	SessionClosed(s ops.Sink)
}

// Options configure a Link.
type Options struct {
	CentralURL string
	Identity   *identity.Identity
	Logger     *slog.Logger
	Registry   *ops.Registry
	Streams    StreamRouter
	// Hello builds the hello frame for each new session.
	Hello func() any
	// OnWelcome is called (synchronously, from the read loop) for each welcome.
	OnWelcome func(w proto.Welcome)
	// OnUp is called after hello is queued on a new session.
	OnUp func(s *Session)
	// Workers bounds concurrently running requests per session.
	Workers int
	// HTTPClient is used for the WebSocket handshake.
	HTTPClient *http.Client
}

// Link is the reconnecting connection to the hub.
type Link struct {
	opts Options
	log  *slog.Logger
	cur  atomic.Pointer[Session]
	skew atomic.Int64 // ms to add to the local clock for X-Screens-Ts
}

// New creates a link.
func New(opts Options) *Link {
	if opts.Workers <= 0 {
		opts.Workers = 32
	}
	if opts.HTTPClient == nil {
		opts.HTTPClient = &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}}
	}
	return &Link{opts: opts, log: opts.Logger}
}

// Current returns the live session, or nil.
func (l *Link) Current() *Session { return l.cur.Load() }

// Up reports whether a session is live.
func (l *Link) Up() bool { return l.cur.Load() != nil }

// SendEvent queues an evt on the live session without blocking. It returns
// false if there is no session or the event queue is full.
func (l *Link) SendEvent(typ string, data any) bool {
	s := l.cur.Load()
	if s == nil {
		return false
	}
	return s.TrySendEvent(typ, data)
}

// ConnectURL maps the central URL to the WebSocket connect endpoint.
func ConnectURL(central string) string {
	u := strings.TrimRight(central, "/")
	switch {
	case strings.HasPrefix(u, "https://"):
		u = "wss://" + strings.TrimPrefix(u, "https://")
	case strings.HasPrefix(u, "http://"):
		u = "ws://" + strings.TrimPrefix(u, "http://")
	}
	return u + "/agent/v1/connect"
}

// Jitter applies ±20% to d.
func Jitter(d time.Duration) time.Duration {
	f := 0.8 + 0.4*rand.Float64()
	return time.Duration(float64(d) * f)
}

func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// Run connects and serves sessions until ctx is cancelled.
func (l *Link) Run(ctx context.Context) {
	backoff := BackoffMin
	next := func() time.Duration {
		w := Jitter(backoff)
		backoff *= 2
		if backoff > BackoffMax {
			backoff = BackoffMax
		}
		return w
	}
	for ctx.Err() == nil {
		conn, resp, err := l.dial(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			wait := next()
			status := 0
			if resp != nil {
				status = resp.StatusCode
			}
			switch status {
			case http.StatusForbidden:
				wait = Jitter(RevokedWait)
				l.log.Error("hub rejected gateway as revoked (403); backing off", "wait", wait.Round(time.Second))
			case http.StatusUnauthorized:
				l.adjustSkew(resp)
				l.log.Warn("hub rejected connect signature (401)", "wait", wait.Round(time.Millisecond))
			default:
				l.log.Warn("connect failed", "status", status, "err", err, "wait", wait.Round(time.Millisecond))
			}
			if !sleep(ctx, wait) {
				return
			}
			continue
		}
		started := time.Now()
		l.serve(ctx, conn)
		if time.Since(started) >= BackoffReset {
			backoff = BackoffMin
		}
		if ctx.Err() != nil {
			return
		}
		wait := next()
		l.log.Info("link down; reconnecting", "up_for", time.Since(started).Round(time.Second), "wait", wait.Round(time.Millisecond))
		if !sleep(ctx, wait) {
			return
		}
	}
}

func (l *Link) adjustSkew(resp *http.Response) {
	if resp == nil {
		return
	}
	d, err := http.ParseTime(resp.Header.Get("Date"))
	if err != nil {
		return
	}
	l.setSkew(d.UnixMilli() - time.Now().UnixMilli())
}

func (l *Link) setSkew(skew int64) {
	if skew > 30000 || skew < -30000 {
		if l.skew.Swap(skew) != skew {
			l.log.Warn("local clock differs from hub; compensating", "skew_ms", skew)
		}
	} else {
		l.skew.Store(0)
	}
}

func (l *Link) dial(ctx context.Context) (*websocket.Conn, *http.Response, error) {
	h, err := l.opts.Identity.ConnectHeaders(time.Now().UnixMilli() + l.skew.Load())
	if err != nil {
		return nil, nil, err
	}
	dctx, cancel := context.WithTimeout(ctx, DialTimeout)
	defer cancel()
	return websocket.Dial(dctx, ConnectURL(l.opts.CentralURL), &websocket.DialOptions{
		HTTPClient: l.opts.HTTPClient,
		HTTPHeader: h,
	})
}

type outFrame struct {
	b      []byte
	after  func()
	binary bool
}

// Session is one connected WebSocket.
type Session struct {
	link   *Link
	conn   *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc
	log    *slog.Logger

	prio   chan outFrame
	stream chan outFrame
	evt    chan outFrame
	jobs   chan *proto.Req

	lastRx        atomic.Int64
	droppedEvents atomic.Uint64
	binary        atomic.Bool // hub accepts binary stream frames
	wg            sync.WaitGroup
}

// Done is closed when the session ends.
func (s *Session) Done() <-chan struct{} { return s.ctx.Done() }

// Context is cancelled when the session ends.
func (s *Session) Context() context.Context { return s.ctx }

// DroppedEvents counts telemetry dropped on this session.
func (s *Session) DroppedEvents() uint64 { return s.droppedEvents.Load() }

func (l *Link) serve(parent context.Context, conn *websocket.Conn) {
	// The session context is not derived from parent: cancelling a Read
	// context makes the websocket library drop the TCP connection, and on
	// shutdown we want a proper close handshake first.
	ctx, cancel := context.WithCancel(context.Background())
	s := &Session{
		link:   l,
		conn:   conn,
		ctx:    ctx,
		cancel: cancel,
		log:    l.log,
		prio:   make(chan outFrame, PrioQueueLen),
		stream: make(chan outFrame, StreamQueue),
		evt:    make(chan outFrame, EventQueueLen),
		jobs:   make(chan *proto.Req, JobQueueLen),
	}
	conn.SetReadLimit(ReadLimit)
	s.lastRx.Store(time.Now().UnixMilli())

	if b, err := json.Marshal(l.opts.Hello()); err == nil {
		s.prio <- outFrame{b: b}
	}
	s.wg.Add(2 + l.opts.Workers)
	go s.writer()
	go s.keepalive()
	for i := 0; i < l.opts.Workers; i++ {
		go s.worker()
	}
	go func() {
		select {
		case <-parent.Done():
			done := make(chan struct{})
			go func() {
				_ = conn.Close(websocket.StatusNormalClosure, "agent shutting down")
				close(done)
			}()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
			}
			cancel()
		case <-ctx.Done():
		}
	}()
	l.cur.Store(s)
	l.log.Info("link up", "url", ConnectURL(l.opts.CentralURL))
	if l.opts.OnUp != nil {
		l.opts.OnUp(s)
	}

	s.readLoop()

	l.cur.CompareAndSwap(s, nil)
	cancel()
	if l.opts.Streams != nil {
		l.opts.Streams.SessionClosed(s)
	}
	conn.CloseNow()
	s.wg.Wait()
}

func (s *Session) readLoop() {
	for {
		typ, b, err := s.conn.Read(s.ctx)
		if err != nil {
			if s.ctx.Err() == nil {
				s.log.Info("link read ended", "err", err)
			}
			return
		}
		s.lastRx.Store(time.Now().UnixMilli())
		if typ != websocket.MessageText {
			id, payload, ok := proto.DecodeBinaryStream(b)
			if !ok {
				s.log.Debug("ignoring unknown binary frame from hub", "bytes", len(b))
				continue
			}
			if s.link.opts.Streams != nil {
				s.link.opts.Streams.InboundBytes(s, id, payload)
			}
			continue
		}
		var env proto.Envelope
		if err := json.Unmarshal(b, &env); err != nil {
			s.log.Warn("bad frame from hub", "err", err)
			continue
		}
		switch env.T {
		case proto.TypePing:
			var p proto.Ping
			_ = json.Unmarshal(b, &p)
			s.sendPrio(proto.Ping{T: proto.TypePong, Ts: p.Ts}, nil)
		case proto.TypePong:
		case proto.TypeWelcome:
			var w proto.Welcome
			if err := json.Unmarshal(b, &w); err != nil {
				s.log.Warn("bad welcome", "err", err)
				continue
			}
			if w.ServerTime > 0 {
				s.link.setSkew(w.ServerTime - time.Now().UnixMilli())
			}
			s.binary.Store(w.BinaryStreams)
			if s.link.opts.OnWelcome != nil {
				s.link.opts.OnWelcome(w)
			}
		case proto.TypeReq:
			var r proto.Req
			if err := json.Unmarshal(b, &r); err != nil || r.ID == "" {
				s.log.Warn("bad req", "err", err)
				continue
			}
			select {
			case s.jobs <- &r:
			default:
				s.sendRes(r.ID, nil, proto.Errf(proto.CodeFailed, "agent busy: %d requests queued", len(s.jobs)), nil)
			}
		case proto.TypeStream:
			var f proto.Stream
			if err := json.Unmarshal(b, &f); err != nil || f.Stream == "" {
				s.log.Warn("bad stream frame", "err", err)
				continue
			}
			if s.link.opts.Streams != nil {
				s.link.opts.Streams.Inbound(s, &f)
			}
		default:
			s.log.Debug("ignoring frame", "t", env.T)
		}
	}
}

func (s *Session) writer() {
	defer s.wg.Done()
	write := func(f outFrame) bool {
		wctx, cancel := context.WithTimeout(s.ctx, WriteTimeout)
		typ := websocket.MessageText
		if f.binary {
			typ = websocket.MessageBinary
		}
		err := s.conn.Write(wctx, typ, f.b)
		cancel()
		if err != nil {
			if s.ctx.Err() == nil {
				s.log.Info("link write failed", "err", err)
			}
			s.cancel()
			return false
		}
		if f.after != nil {
			go f.after()
		}
		return true
	}
	for {
		// Strict priority for res/pong/hello.
		select {
		case f := <-s.prio:
			if !write(f) {
				return
			}
			continue
		default:
		}
		select {
		case <-s.ctx.Done():
			return
		case f := <-s.prio:
			if !write(f) {
				return
			}
		case f := <-s.stream:
			if !write(f) {
				return
			}
		case f := <-s.evt:
			if !write(f) {
				return
			}
		}
	}
}

func (s *Session) keepalive() {
	defer s.wg.Done()
	ping := time.NewTicker(PingInterval)
	defer ping.Stop()
	checkEvery := IdleTimeout / 18
	if checkEvery < 10*time.Millisecond {
		checkEvery = 10 * time.Millisecond
	}
	check := time.NewTicker(checkEvery)
	defer check.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ping.C:
			s.sendPrio(proto.Ping{T: proto.TypePing, Ts: time.Now().UnixMilli()}, nil)
		case <-check.C:
			if idle := time.Since(time.UnixMilli(s.lastRx.Load())); idle > IdleTimeout {
				s.log.Warn("no frame from hub; dropping link", "idle", idle.Round(time.Second))
				s.cancel()
				return
			}
		}
	}
}

func (s *Session) worker() {
	defer s.wg.Done()
	for {
		select {
		case <-s.ctx.Done():
			return
		case r := <-s.jobs:
			s.run(r)
		}
	}
}

func (s *Session) run(r *proto.Req) {
	timeout := ops.MsOr(r.TimeoutMs, DefaultReqMs, MaxReqMs)
	ctx, cancel := context.WithTimeout(ops.WithSink(s.ctx, s), time.Duration(timeout)*time.Millisecond)
	defer cancel()
	type result struct {
		data any
		err  error
	}
	ch := make(chan result, 1)
	start := time.Now()
	go func() {
		d, err := s.link.opts.Registry.Call(ctx, r.Op, r.Args)
		ch <- result{d, err}
	}()
	var res result
	select {
	case res = <-ch:
	case <-ctx.Done():
		select {
		case res = <-ch:
		default:
			if s.ctx.Err() != nil {
				return
			}
			res = result{err: proto.Errf(proto.CodeTimeout, "%s exceeded %dms", r.Op, timeout)}
		}
	}
	if res.err != nil && errors.Is(res.err, context.DeadlineExceeded) && ctx.Err() != nil {
		res.err = proto.Errf(proto.CodeTimeout, "%s exceeded %dms", r.Op, timeout)
	}
	var after func()
	if a, ok := res.data.(ops.After); ok {
		res.data, after = a.Data, a.Fn
	}
	lvl := slog.LevelDebug
	if res.err != nil {
		lvl = slog.LevelInfo
	}
	s.log.Log(s.ctx, lvl, "req", "id", r.ID, "op", r.Op, "ok", res.err == nil, "ms", time.Since(start).Milliseconds(), "err", res.err)
	s.sendRes(r.ID, res.data, res.err, after)
}

func (s *Session) sendRes(id string, data any, err error, after func()) {
	res := proto.Res{T: proto.TypeRes, ID: id, OK: err == nil}
	if err != nil {
		res.Error = proto.AsError(err)
	} else if data == nil {
		res.Data = struct{}{}
	} else {
		res.Data = data
	}
	b, merr := json.Marshal(res)
	if merr == nil && len(b) > proto.MaxFrame {
		merr = errors.New("result exceeds the 512 KiB frame limit")
	}
	if merr != nil {
		res = proto.Res{T: proto.TypeRes, ID: id, OK: false, Error: proto.Errf(proto.CodeFailed, "encode result: %v", merr)}
		b, _ = json.Marshal(res)
		after = nil
	}
	select {
	case s.prio <- outFrame{b: b, after: after}:
	case <-s.ctx.Done():
	}
}

func (s *Session) sendPrio(v any, after func()) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	select {
	case s.prio <- outFrame{b: b, after: after}:
	case <-s.ctx.Done():
	}
}

// ErrSessionClosed is returned when sending on an ended session.
var ErrSessionClosed = errors.New("link session closed")

// SendStream implements ops.Sink.
func (s *Session) SendStream(ctx context.Context, f *proto.Stream) error {
	b, err := json.Marshal(f)
	if err != nil {
		return err
	}
	if len(b) > proto.MaxFrame {
		return proto.ErrFrameTooLarge
	}
	select {
	case s.stream <- outFrame{b: b}:
		return nil
	case <-s.ctx.Done():
		return ErrSessionClosed
	case <-ctx.Done():
		return ctx.Err()
	}
}

// SendStreamBytes implements ops.Sink.
func (s *Session) SendStreamBytes(ctx context.Context, id string, data []byte) error {
	if !s.binary.Load() {
		return s.SendStream(ctx, proto.StreamBinary(id, base64.StdEncoding.EncodeToString(data)))
	}
	b := proto.EncodeBinaryStream(id, data)
	if len(b) > proto.MaxFrame {
		return proto.ErrFrameTooLarge
	}
	select {
	case s.stream <- outFrame{b: b, binary: true}:
		return nil
	case <-s.ctx.Done():
		return ErrSessionClosed
	case <-ctx.Done():
		return ctx.Err()
	}
}

// TrySendEvent queues an evt without blocking.
func (s *Session) TrySendEvent(typ string, data any) bool {
	b, err := json.Marshal(proto.Evt{T: proto.TypeEvt, Type: typ, Data: data})
	if err != nil || len(b) > proto.MaxFrame {
		s.droppedEvents.Add(1)
		return false
	}
	if s.ctx.Err() != nil {
		return false
	}
	select {
	case s.evt <- outFrame{b: b}:
		return true
	default:
		s.droppedEvents.Add(1)
		return false
	}
}
