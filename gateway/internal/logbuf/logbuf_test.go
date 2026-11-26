package logbuf

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestRing(t *testing.T) {
	r := NewRing(3)
	if got := r.Last(10); len(got) != 0 {
		t.Fatalf("empty ring: %v", got)
	}
	r.Add("a")
	r.Add("b")
	if got := strings.Join(r.Last(10), ","); got != "a,b" {
		t.Fatalf("got %s", got)
	}
	r.Add("c")
	r.Add("d")
	if got := strings.Join(r.Last(10), ","); got != "b,c,d" {
		t.Fatalf("got %s", got)
	}
	if got := strings.Join(r.Last(2), ","); got != "c,d" {
		t.Fatalf("got %s", got)
	}
}

func TestHandler(t *testing.T) {
	var out bytes.Buffer
	ring := NewRing(10)
	lv := new(slog.LevelVar)
	h := New(&out, ring, lv)
	var hooked []string
	h.SetHook(func(level slog.Level, msg string, ts time.Time) {
		hooked = append(hooked, LevelName(level)+":"+msg)
	})
	log := slog.New(h).With("comp", "dns").WithGroup("g")
	log.Debug("hidden")
	log.Info("hello world", "n", 3, "s", "a b")
	log.Warn("careful", "err", errors.New("boom"))
	lines := ring.Last(0)
	if len(lines) != 2 {
		t.Fatalf("lines: %v", lines)
	}
	if !strings.Contains(lines[0], `INFO hello world comp=dns g.n=3 g.s="a b"`) {
		t.Fatalf("line0: %s", lines[0])
	}
	if len(hooked) != 1 || hooked[0] != "warn:careful comp=dns g.err=boom" {
		t.Fatalf("hooked: %v", hooked)
	}
	if strings.Count(out.String(), "\n") != 2 {
		t.Fatalf("out: %q", out.String())
	}
	lv.Set(slog.LevelDebug)
	log.Debug("shown")
	if len(ring.Last(0)) != 3 {
		t.Fatal("debug not shown after level change")
	}
	if ParseLevel("WARN") != slog.LevelWarn || ParseLevel("bogus") != slog.LevelInfo {
		t.Fatal("ParseLevel")
	}
}
