// Package identity manages the gateway's Ed25519 identity: enrollment
// (PROTOCOL.md §1) and the signed connect headers (§2).
package identity

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/astralwalker0o/screens/gateway/internal/config"
)

// FileName is the identity file inside $DATA.
const FileName = "identity.json"

// SignPrefix is the domain-separation prefix of the connect signature.
const SignPrefix = "screens-agent-v1\n"

// Identity is the persisted gateway identity.
type Identity struct {
	SiteID     string `json:"site_id"`
	GatewayID  string `json:"gateway_id"`
	PrivateKey string `json:"private_key"` // base64url (unpadded) of the 64-byte seed||pub
	CentralURL string `json:"central_url"`
	SiteName   string `json:"site_name,omitempty"`

	key ed25519.PrivateKey
}

// B64 is the base64url encoding used for keys, nonces and signatures
// (RFC 4648 §5, no padding).
var B64 = base64.RawURLEncoding

// DecodeB64URL accepts base64url with or without padding.
func DecodeB64URL(s string) ([]byte, error) {
	return B64.DecodeString(strings.TrimRight(s, "="))
}

// Key returns the private key.
func (id *Identity) Key() ed25519.PrivateKey { return id.key }

// PublicKeyB64 returns the base64url public key.
func (id *Identity) PublicKeyB64() string {
	return B64.EncodeToString(id.key.Public().(ed25519.PublicKey))
}

// Load reads $DATA/identity.json. It returns os.ErrNotExist if absent.
func Load(dataDir string) (*Identity, error) {
	b, err := os.ReadFile(filepath.Join(dataDir, FileName))
	if err != nil {
		return nil, err
	}
	var id Identity
	if err := json.Unmarshal(b, &id); err != nil {
		return nil, fmt.Errorf("parse identity: %w", err)
	}
	raw, err := DecodeB64URL(id.PrivateKey)
	if err != nil {
		return nil, fmt.Errorf("identity private_key: %w", err)
	}
	switch len(raw) {
	case ed25519.PrivateKeySize:
		id.key = ed25519.PrivateKey(raw)
	case ed25519.SeedSize:
		id.key = ed25519.NewKeyFromSeed(raw)
	default:
		return nil, fmt.Errorf("identity private_key has %d bytes", len(raw))
	}
	if id.GatewayID == "" {
		return nil, errors.New("identity has no gateway_id")
	}
	return &id, nil
}

// Save writes the identity with mode 0600.
func (id *Identity) Save(dataDir string) error {
	id.PrivateKey = B64.EncodeToString(id.key)
	b, err := json.MarshalIndent(id, "", "  ")
	if err != nil {
		return err
	}
	return config.WriteFileAtomic(filepath.Join(dataDir, FileName), b, 0o600)
}

// EnrollRequest is the body of POST /agent/v1/enroll.
type EnrollRequest struct {
	Token     string `json:"token"`
	PublicKey string `json:"public_key"`
	Hostname  string `json:"hostname"`
	Version   string `json:"version"`
	OS        string `json:"os"`
	Arch      string `json:"arch"`
}

// EnrollResponse is the 200 body.
type EnrollResponse struct {
	SiteID    string `json:"site_id"`
	SiteName  string `json:"site_name"`
	GatewayID string `json:"gateway_id"`
}

// EnrollError is returned for non-200 responses.
type EnrollError struct {
	Status  int
	Code    string
	Message string
}

func (e *EnrollError) Error() string {
	return fmt.Sprintf("enroll failed: HTTP %d %s: %s", e.Status, e.Code, e.Message)
}

// Gone reports whether the token was used or expired (HTTP 410).
func (e *EnrollError) Gone() bool { return e.Status == http.StatusGone }

// Enroll generates a keypair and registers it with the central app. On
// success the identity is saved to dataDir.
func Enroll(ctx context.Context, client *http.Client, dataDir, centralURL string, req EnrollRequest) (*Identity, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	req.PublicKey = B64.EncodeToString(priv.Public().(ed25519.PublicKey))
	body, _ := json.Marshal(req)
	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(centralURL, "/")+"/agent/v1/enroll", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	hreq.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(hreq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(rb, &e)
		if e.Message == "" && e.Error == "" {
			e.Message = strings.TrimSpace(string(rb))
		}
		return nil, &EnrollError{Status: resp.StatusCode, Code: e.Error, Message: e.Message}
	}
	var er EnrollResponse
	if err := json.Unmarshal(rb, &er); err != nil {
		return nil, fmt.Errorf("enroll: bad response: %w", err)
	}
	if er.GatewayID == "" || er.SiteID == "" {
		return nil, errors.New("enroll: response missing site_id/gateway_id")
	}
	id := &Identity{SiteID: er.SiteID, GatewayID: er.GatewayID, SiteName: er.SiteName, CentralURL: strings.TrimRight(centralURL, "/"), key: priv}
	if err := id.Save(dataDir); err != nil {
		return nil, fmt.Errorf("save identity: %w", err)
	}
	return id, nil
}

// SignMessage builds the string that is signed for a connect.
func SignMessage(gatewayID, ts, nonce string) []byte {
	return []byte(SignPrefix + gatewayID + "\n" + ts + "\n" + nonce)
}

// ConnectHeaders returns the four X-Screens-* headers for a connect at tsMs.
func (id *Identity) ConnectHeaders(tsMs int64) (http.Header, error) {
	nb := make([]byte, 16)
	if _, err := rand.Read(nb); err != nil {
		return nil, err
	}
	nonce := B64.EncodeToString(nb)
	ts := strconv.FormatInt(tsMs, 10)
	sig := ed25519.Sign(id.key, SignMessage(id.GatewayID, ts, nonce))
	h := http.Header{}
	h.Set("X-Screens-Gateway", id.GatewayID)
	h.Set("X-Screens-Ts", ts)
	h.Set("X-Screens-Nonce", nonce)
	h.Set("X-Screens-Sig", B64.EncodeToString(sig))
	return h, nil
}

// Verify checks connect headers against a public key (used by tests and as
// executable documentation of the scheme).
func Verify(pub ed25519.PublicKey, h http.Header) bool {
	sig, err := DecodeB64URL(h.Get("X-Screens-Sig"))
	if err != nil {
		return false
	}
	return ed25519.Verify(pub, SignMessage(h.Get("X-Screens-Gateway"), h.Get("X-Screens-Ts"), h.Get("X-Screens-Nonce")), sig)
}

// NewForTest builds an in-memory identity (tests only).
func NewForTest(gatewayID string) *Identity {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	return &Identity{GatewayID: gatewayID, SiteID: "site_test", key: priv}
}
