package ops

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/astralwalker0o/screens/gateway/internal/proto"
)

func TestRegistry(t *testing.T) {
	r := New()
	r.Register("x.ok", func(ctx context.Context, args json.RawMessage) (any, error) {
		var a struct{ N int }
		if err := Decode(args, &a); err != nil {
			return nil, err
		}
		return map[string]int{"n": a.N * 2}, nil
	})
	r.Register("x.panic", func(ctx context.Context, args json.RawMessage) (any, error) { panic("boom") })
	d, err := r.Call(context.Background(), "x.ok", json.RawMessage(`{"N":2}`))
	if err != nil || d.(map[string]int)["n"] != 4 {
		t.Fatal(d, err)
	}
	var pe *proto.Error
	if _, err := r.Call(context.Background(), "nope", nil); !errors.As(err, &pe) || pe.Code != proto.CodeUnknownOp {
		t.Fatal(err)
	}
	if _, err := r.Call(context.Background(), "x.ok", json.RawMessage(`{"N":"x"}`)); !errors.As(err, &pe) || pe.Code != proto.CodeBadArgs {
		t.Fatal(err)
	}
	if _, err := r.Call(context.Background(), "x.panic", nil); !errors.As(err, &pe) || pe.Code != proto.CodeFailed {
		t.Fatal(err)
	}
}

func TestFitFrame(t *testing.T) {
	big := strings.Repeat("\x01", 2<<20) // escapes to \u0001 (6x)
	d, shrunk := FitFrame(len(big), func(limit int) any {
		return map[string]string{"body": TruncateUTF8(big, limit)}
	})
	if !shrunk {
		t.Fatal("not shrunk")
	}
	if n := proto.FrameSize(d); n > proto.FrameBudget || n < proto.FrameBudget/2 {
		t.Fatalf("size %d", n)
	}
	d, shrunk = FitFrame(10, func(limit int) any { return map[string]string{"body": "hello"[:min(limit, 5)]} })
	if shrunk || d.(map[string]string)["body"] != "hello" {
		t.Fatal(d)
	}
}

func TestTruncateUTF8(t *testing.T) {
	s := "aé€"
	if TruncateUTF8(s, 2) != "a" || TruncateUTF8(s, 3) != "aé" || TruncateUTF8(s, 100) != s {
		t.Fatal("truncate")
	}
}

func TestParseMeminfo(t *testing.T) {
	m := ParseMeminfo([]byte("MemTotal:        2048 kB\nMemFree:          100 kB\nMemAvailable:    1024 kB\n"))
	if m.Total != 2048*1024 || m.Available != 1024*1024 {
		t.Fatalf("%+v", m)
	}
	if l := ReadLoad(); l[0] < 0 {
		t.Fatal(l)
	}
	if d := ReadDisk(t.TempDir()); d.Total == 0 {
		t.Fatal("disk")
	}
}
