package identity

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestEnrollAndSign(t *testing.T) {
	var gotPub ed25519.PublicKey
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agent/v1/enroll" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		var req EnrollRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Token == "enr_used" {
			w.WriteHeader(http.StatusGone)
			_, _ = w.Write([]byte(`{"error":"token_used","message":"token already used"}`))
			return
		}
		raw, err := B64.DecodeString(req.PublicKey)
		if err != nil || len(raw) != 32 {
			w.WriteHeader(400)
			return
		}
		gotPub = raw
		_, _ = w.Write([]byte(`{"site_id":"site_abc","site_name":"Beach House","gateway_id":"gw_xyz"}`))
	}))
	defer srv.Close()
	dir := t.TempDir()

	_, err := Enroll(context.Background(), srv.Client(), dir, srv.URL, EnrollRequest{Token: "enr_used"})
	var ee *EnrollError
	if !errors.As(err, &ee) || !ee.Gone() || ee.Message != "token already used" {
		t.Fatalf("expected 410, got %v", err)
	}

	id, err := Enroll(context.Background(), srv.Client(), dir, srv.URL, EnrollRequest{Token: "enr_ok", Hostname: "h", Version: "0.1.0", OS: "linux", Arch: "amd64"})
	if err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(filepath.Join(dir, FileName))
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("identity file: %v %v", st, err)
	}
	loaded, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.GatewayID != "gw_xyz" || loaded.SiteID != "site_abc" || loaded.CentralURL != srv.URL {
		t.Fatalf("loaded %+v", loaded)
	}
	if !loaded.Key().Public().(ed25519.PublicKey).Equal(gotPub) || loaded.PublicKeyB64() != id.PublicKeyB64() {
		t.Fatal("public key mismatch")
	}
	raw, _ := DecodeB64URL(loaded.PrivateKey)
	if len(raw) != 64 {
		t.Fatalf("private key len %d", len(raw))
	}

	h, err := loaded.ConnectHeaders(1764120000000)
	if err != nil {
		t.Fatal(err)
	}
	if h.Get("X-Screens-Gateway") != "gw_xyz" || h.Get("X-Screens-Ts") != "1764120000000" {
		t.Fatalf("headers %v", h)
	}
	nonce, _ := DecodeB64URL(h.Get("X-Screens-Nonce"))
	if len(nonce) != 16 {
		t.Fatalf("nonce len %d", len(nonce))
	}
	if !Verify(gotPub, h) {
		t.Fatal("signature does not verify")
	}
	// Explicit check of the signed string.
	sig, _ := DecodeB64URL(h.Get("X-Screens-Sig"))
	msg := "screens-agent-v1\ngw_xyz\n1764120000000\n" + h.Get("X-Screens-Nonce")
	if !ed25519.Verify(gotPub, []byte(msg), sig) {
		t.Fatal("signature over documented message fails")
	}
	h.Set("X-Screens-Ts", "1764120000001")
	if Verify(gotPub, h) {
		t.Fatal("tampered ts verified")
	}
}

func TestLoadPadded(t *testing.T) {
	dir := t.TempDir()
	id := NewForTest("gw_1")
	if err := id.Save(dir); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, FileName))
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	m["private_key"] = m["private_key"].(string) + "=="
	b, _ = json.Marshal(m)
	_ = os.WriteFile(filepath.Join(dir, FileName), b, 0o600)
	if _, err := Load(dir); err != nil {
		t.Fatalf("padded key: %v", err)
	}
	if _, err := Load(t.TempDir()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing: %v", err)
	}
}
