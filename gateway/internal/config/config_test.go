package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/astralwalker0o/screens/gateway/internal/proto"
)

func TestStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Update(func(p *Persisted) {
		p.DNS = json.RawMessage(`{"enabled":true}`)
		p.Telemetry = &proto.Telemetry{DNSBatchMs: 1000}
	}); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", st.Mode())
	}
	s2, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	got := s2.Get()
	if string(got.DNS) != `{"enabled":true}` || got.Telemetry.DNSBatchMs != 1000 {
		t.Fatalf("got %+v", got)
	}
}

func TestFromEnvDefaults(t *testing.T) {
	t.Setenv("SCREENS_DATA", "")
	t.Setenv("SCREENS_CENTRAL_URL", "https://x.example/")
	e := FromEnv()
	if e.DataDir != "/data" || e.LogLevel != "info" || e.CentralURL != "https://x.example" {
		t.Fatalf("%+v", e)
	}
}
