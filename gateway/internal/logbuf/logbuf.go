// Package logbuf provides a slog.Handler that writes logfmt-style lines to an
// io.Writer, keeps the most recent lines in an in-memory ring buffer (for
// sys.logs) and forwards warn+ records to a hook (for `log` events).
package logbuf

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
)

// Ring is a fixed-size ring of log lines.
type Ring struct {
	mu    sync.Mutex
	lines []string
	next  int
	full  bool
}

// NewRing creates a ring holding up to n lines.
func NewRing(n int) *Ring {
	if n < 1 {
		n = 1
	}
	return &Ring{lines: make([]string, n)}
}

// Add appends a line.
func (r *Ring) Add(line string) {
	r.mu.Lock()
	r.lines[r.next] = line
	r.next++
	if r.next == len(r.lines) {
		r.next = 0
		r.full = true
	}
	r.mu.Unlock()
}

// Last returns up to n most recent lines, oldest first.
func (r *Ring) Last(n int) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	size := r.next
	if r.full {
		size = len(r.lines)
	}
	if n <= 0 || n > size {
		n = size
	}
	out := make([]string, 0, n)
	start := r.next - n
	if start < 0 {
		start += len(r.lines)
	}
	for i := 0; i < n; i++ {
		out = append(out, r.lines[(start+i)%len(r.lines)])
	}
	return out
}

// Cap returns the ring capacity.
func (r *Ring) Cap() int { return len(r.lines) }

// Hook receives warn+ records. It must not block or log.
type Hook func(level slog.Level, msg string, ts time.Time)

type shared struct {
	mu    sync.Mutex
	out   io.Writer
	ring  *Ring
	level *slog.LevelVar
	hook  atomic.Pointer[Hook]
}

// Handler implements slog.Handler.
type Handler struct {
	s      *shared
	prefix string // preformatted attrs from WithAttrs
	group  string // dotted group prefix for keys
}

// New creates a handler. out may be nil.
func New(out io.Writer, ring *Ring, level *slog.LevelVar) *Handler {
	if level == nil {
		level = new(slog.LevelVar)
	}
	return &Handler{s: &shared{out: out, ring: ring, level: level}}
}

// SetHook installs the warn+ hook (nil to remove).
func (h *Handler) SetHook(fn Hook) {
	if fn == nil {
		h.s.hook.Store(nil)
		return
	}
	h.s.hook.Store(&fn)
}

// Enabled implements slog.Handler.
func (h *Handler) Enabled(_ context.Context, l slog.Level) bool { return l >= h.s.level.Level() }

// Handle implements slog.Handler.
func (h *Handler) Handle(_ context.Context, r slog.Record) error {
	var body strings.Builder
	body.WriteString(r.Message)
	body.WriteString(h.prefix)
	r.Attrs(func(a slog.Attr) bool {
		appendAttr(&body, h.group, a)
		return true
	})
	msg := body.String()
	ts := r.Time
	if ts.IsZero() {
		ts = time.Now()
	}
	line := ts.UTC().Format("2006-01-02T15:04:05.000Z") + " " + levelString(r.Level) + " " + msg
	if h.s.ring != nil {
		h.s.ring.Add(line)
	}
	if h.s.out != nil {
		h.s.mu.Lock()
		_, _ = io.WriteString(h.s.out, line+"\n")
		h.s.mu.Unlock()
	}
	if r.Level >= slog.LevelWarn {
		if hp := h.s.hook.Load(); hp != nil {
			(*hp)(r.Level, msg, ts)
		}
	}
	return nil
}

// WithAttrs implements slog.Handler.
func (h *Handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	var b strings.Builder
	b.WriteString(h.prefix)
	for _, a := range attrs {
		appendAttr(&b, h.group, a)
	}
	return &Handler{s: h.s, prefix: b.String(), group: h.group}
}

// WithGroup implements slog.Handler.
func (h *Handler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	return &Handler{s: h.s, prefix: h.prefix, group: h.group + name + "."}
}

func appendAttr(b *strings.Builder, group string, a slog.Attr) {
	a.Value = a.Value.Resolve()
	if a.Equal(slog.Attr{}) {
		return
	}
	if a.Value.Kind() == slog.KindGroup {
		g := group
		if a.Key != "" {
			g = group + a.Key + "."
		}
		for _, sub := range a.Value.Group() {
			appendAttr(b, g, sub)
		}
		return
	}
	b.WriteByte(' ')
	b.WriteString(group)
	b.WriteString(a.Key)
	b.WriteByte('=')
	b.WriteString(quote(valueString(a.Value)))
}

func valueString(v slog.Value) string {
	switch v.Kind() {
	case slog.KindString:
		return v.String()
	case slog.KindTime:
		return v.Time().UTC().Format(time.RFC3339Nano)
	case slog.KindDuration:
		return v.Duration().String()
	default:
		if err, ok := v.Any().(error); ok {
			return err.Error()
		}
		return fmt.Sprint(v.Any())
	}
}

func quote(s string) string {
	if s == "" {
		return `""`
	}
	for _, r := range s {
		if unicode.IsSpace(r) || r == '"' || r == '=' || !unicode.IsPrint(r) {
			return strconv.Quote(s)
		}
	}
	return s
}

func levelString(l slog.Level) string {
	switch {
	case l >= slog.LevelError:
		return "ERROR"
	case l >= slog.LevelWarn:
		return "WARN"
	case l >= slog.LevelInfo:
		return "INFO"
	default:
		return "DEBUG"
	}
}

// LevelName is the lower-case level name used in `log` events.
func LevelName(l slog.Level) string { return strings.ToLower(levelString(l)) }

// ParseLevel parses debug/info/warn/error (default info).
func ParseLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
