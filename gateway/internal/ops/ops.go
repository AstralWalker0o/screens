// Package ops is the registry of hub → agent operations (PROTOCOL.md §5)
// plus helpers shared by op implementations.
package ops

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"unicode/utf8"

	"github.com/astralwalker0o/screens/gateway/internal/proto"
)

// Handler runs one operation. It returns the res data (any JSON-encodable
// value; nil becomes {}) or an error (preferably *proto.Error).
type Handler func(ctx context.Context, args json.RawMessage) (any, error)

// Registry maps op names to handlers.
type Registry struct {
	mu sync.RWMutex
	m  map[string]Handler
}

// New creates an empty registry.
func New() *Registry { return &Registry{m: map[string]Handler{}} }

// Register adds or replaces an op.
func (r *Registry) Register(op string, h Handler) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.m[op] = h
}

// Names lists registered ops.
func (r *Registry) Names() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.m))
	for k := range r.m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Call dispatches op. Panics in handlers are converted to "failed".
func (r *Registry) Call(ctx context.Context, op string, args json.RawMessage) (data any, err error) {
	r.mu.RLock()
	h, ok := r.m[op]
	r.mu.RUnlock()
	if !ok {
		return nil, proto.Errf(proto.CodeUnknownOp, "unknown op %q", op)
	}
	defer func() {
		if p := recover(); p != nil {
			data, err = nil, proto.Errf(proto.CodeFailed, "panic in %s: %v", op, p)
		}
	}()
	return h(ctx, args)
}

// After wraps result data with a function to run once the res frame has
// been written to the link (used by sys.update / sys.restart).
type After struct {
	Data any
	Fn   func()
}

// Sink is the link session a stream belongs to.
type Sink interface {
	// SendStream queues a stream frame, blocking for backpressure. It fails
	// if the session ends or the frame is larger than the frame limit.
	SendStream(ctx context.Context, f *proto.Stream) error
	// Done is closed when the session ends.
	Done() <-chan struct{}
}

type sinkKey struct{}

// WithSink attaches the session to a request context.
func WithSink(ctx context.Context, s Sink) context.Context {
	return context.WithValue(ctx, sinkKey{}, s)
}

// SinkFrom returns the session of a request context (nil if none).
func SinkFrom(ctx context.Context) Sink {
	s, _ := ctx.Value(sinkKey{}).(Sink)
	return s
}

// Decode unmarshals args into v, mapping errors to bad_args. Empty args
// leave v untouched.
func Decode(args json.RawMessage, v any) error {
	args = bytes.TrimSpace(args)
	if len(args) == 0 || string(args) == "null" {
		return nil
	}
	if err := json.Unmarshal(args, v); err != nil {
		return proto.Errf(proto.CodeBadArgs, "invalid args: %v", err)
	}
	return nil
}

// BadArgs is shorthand for a bad_args error.
func BadArgs(format string, a ...any) error { return proto.Errf(proto.CodeBadArgs, format, a...) }

// TruncateUTF8 cuts s to at most n bytes without splitting a rune.
func TruncateUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// FitFrame calls build with decreasing byte limits until the encoded
// result fits in a res frame. build receives the limit to apply to its
// largest field and returns the data. It returns the data and whether the
// limit had to be lowered below start.
func FitFrame(start int, build func(limit int) any) (any, bool) {
	limit := start
	for i := 0; i < 32; i++ {
		d := build(limit)
		size := proto.FrameSize(d)
		if size <= proto.FrameBudget {
			return d, limit < start
		}
		// Scale proportionally (the field may be inflated by JSON escaping
		// or base64), with a little headroom.
		next := int(float64(limit) * float64(proto.FrameBudget) / float64(size) * 0.97)
		if next >= limit {
			next = limit * 3 / 4
		}
		limit = next
		if limit <= 0 {
			return build(0), true
		}
	}
	return build(0), true
}

// Duration helpers for args in milliseconds.
func MsOr(v, def, max int64) int64 {
	if v <= 0 {
		v = def
	}
	if max > 0 && v > max {
		v = max
	}
	return v
}

// Errorf wraps an error with context while keeping its code.
func Errorf(code string, err error, format string, a ...any) error {
	msg := fmt.Sprintf(format, a...)
	if err != nil {
		msg += ": " + err.Error()
	}
	return &proto.Error{Code: code, Message: msg}
}
