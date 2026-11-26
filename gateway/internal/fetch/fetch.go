// Package fetch downloads and uploads files over the signed URLs of
// PROTOCOL.md §7. URLs are opaque, but they must point at the central app's
// origin: the agent only connects out to the central URL (§4).
package fetch

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/astralwalker0o/screens/gateway/internal/proto"
)

// Client is an HTTP client for central-origin URLs.
type Client struct {
	mu     sync.RWMutex
	origin *url.URL
	HTTP   *http.Client
}

// NewCloudTransport returns the transport used for connections to the cloud
// (central app, DoH upstreams). It honours HTTPS_PROXY from the environment.
func NewCloudTransport() *http.Transport {
	return &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          16,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
}

// NewCloudTransportHTTP1 is NewCloudTransport restricted to HTTP/1.1, as
// needed for WebSocket upgrades (an h2 ALPN negotiation would break them).
func NewCloudTransportHTTP1() *http.Transport {
	t := NewCloudTransport()
	t.ForceAttemptHTTP2 = false
	t.TLSNextProto = map[string]func(string, *tls.Conn) http.RoundTripper{}
	return t
}

// New returns a client bound to the given central URL (may be empty and set
// later with SetOrigin).
func New(central string) *Client {
	c := &Client{HTTP: &http.Client{Transport: NewCloudTransport()}}
	c.SetOrigin(central)
	return c
}

// SetOrigin changes the allowed origin.
func (c *Client) SetOrigin(central string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if central == "" {
		c.origin = nil
		return
	}
	u, err := url.Parse(central)
	if err != nil {
		c.origin = nil
		return
	}
	c.origin = u
}

func defaultPort(u *url.URL) string {
	if p := u.Port(); p != "" {
		return p
	}
	if u.Scheme == "https" {
		return "443"
	}
	return "80"
}

// Check validates that raw is an http(s) URL on the central origin.
func (c *Client) Check(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return nil, proto.Errf(proto.CodeBadArgs, "invalid url %q", raw)
	}
	c.mu.RLock()
	o := c.origin
	c.mu.RUnlock()
	if o == nil {
		return nil, proto.Errf(proto.CodeFailed, "central URL unknown; cannot fetch %s", u.Redacted())
	}
	if !strings.EqualFold(u.Scheme, o.Scheme) || !strings.EqualFold(u.Hostname(), o.Hostname()) || defaultPort(u) != defaultPort(o) {
		return nil, proto.Errf(proto.CodeForbidden, "url %s://%s is not on the central origin", u.Scheme, u.Host)
	}
	return u, nil
}

// HTTPError is a non-2xx response.
type HTTPError struct {
	Status int
	Body   string
}

func (e *HTTPError) Error() string { return fmt.Sprintf("HTTP %d: %s", e.Status, e.Body) }

// Download GETs raw into dst (created/truncated, mode 0644), verifying the
// sha256 (hex, case-insensitive) if wantSHA is non-empty, and refusing bodies
// larger than max bytes. On any failure dst is removed.
func (c *Client) Download(ctx context.Context, raw, dst, wantSHA string, max int64) (n int64, err error) {
	u, err := c.Check(raw)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return 0, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return 0, &HTTPError{Status: resp.StatusCode, Body: strings.TrimSpace(string(b))}
	}
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return 0, err
	}
	defer func() {
		if cerr := f.Close(); err == nil && cerr != nil {
			err = cerr
		}
		if err != nil {
			os.Remove(dst)
		}
	}()
	h := sha256.New()
	n, err = io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, max+1))
	if err != nil {
		return n, err
	}
	if n > max {
		return n, proto.Errf(proto.CodeFailed, "download exceeds %d bytes", max)
	}
	if wantSHA != "" {
		if got := hex.EncodeToString(h.Sum(nil)); !strings.EqualFold(got, strings.TrimSpace(wantSHA)) {
			return n, proto.Errf(proto.CodeFailed, "sha256 mismatch: got %s want %s", got, wantSHA)
		}
	}
	return n, f.Sync()
}

// Put uploads body to raw with the given content type.
func (c *Client) Put(ctx context.Context, raw, contentType string, body []byte) error {
	u, err := c.Check(raw)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, u.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", contentType)
	req.ContentLength = int64(len(body))
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	if resp.StatusCode/100 != 2 {
		return &HTTPError{Status: resp.StatusCode, Body: strings.TrimSpace(string(b))}
	}
	return nil
}

// IsHTTPError reports whether err is an HTTPError.
func IsHTTPError(err error) bool {
	var he *HTTPError
	return errors.As(err, &he)
}
