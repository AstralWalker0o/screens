// Package relay implements the LAN relay primitives (PROTOCOL.md §5):
// http.request, and ws.open / tcp.open streams multiplexed over the link.
// Every target passes the guard (§4) at resolve time and again at connect
// time; proxies from the environment are never used for LAN traffic.
package relay

import (
	"crypto/tls"
	"errors"
	"net/http"
	"time"

	"github.com/astralwalker0o/screens/gateway/internal/guard"
)

// InsecureTLS is the TLS config used when insecure_tls is set. LAN devices
// (Samsung, LG) use self-signed certificates and often old TLS stacks, so
// besides skipping verification it re-enables TLS 1.0+ and legacy cipher
// suites and avoids the large post-quantum key share in the ClientHello.
func InsecureTLS() *tls.Config {
	var suites []uint16
	for _, c := range tls.CipherSuites() {
		suites = append(suites, c.ID)
	}
	for _, c := range tls.InsecureCipherSuites() {
		suites = append(suites, c.ID)
	}
	return &tls.Config{
		InsecureSkipVerify: true, //nolint:gosec // LAN devices with self-signed certs; opt-in per request
		MinVersion:         tls.VersionTLS10,
		CipherSuites:       suites,
		CurvePreferences:   []tls.CurveID{tls.X25519, tls.CurveP256, tls.CurveP384},
	}
}

func newTransport(insecure bool) *http.Transport {
	var tc *tls.Config
	if insecure {
		tc = InsecureTLS()
	} else {
		tc = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	return &http.Transport{
		Proxy:                 nil, // never proxy LAN traffic
		DialContext:           guard.Dialer{Timeout: 10 * time.Second}.DialContext,
		TLSClientConfig:       tc,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 0,
		MaxIdleConnsPerHost:   4,
		IdleConnTimeout:       60 * time.Second,
		ForceAttemptHTTP2:     false,
	}
}

var errNoRedirect = errors.New("redirects disabled")

// clients holds the four HTTP client variants (secure/insecure × follow
// redirects or not). Redirect targets are dialled through the guard too.
type clients struct {
	secure, insecure                 *http.Transport
	secureNoFollow, insecureNoFollow *http.Client
	secureFollow, insecureFollow     *http.Client
}

func newClients() *clients {
	c := &clients{secure: newTransport(false), insecure: newTransport(true)}
	noFollow := func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }
	follow := func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("stopped after 5 redirects")
		}
		return nil
	}
	c.secureNoFollow = &http.Client{Transport: c.secure, CheckRedirect: noFollow}
	c.insecureNoFollow = &http.Client{Transport: c.insecure, CheckRedirect: noFollow}
	c.secureFollow = &http.Client{Transport: c.secure, CheckRedirect: follow}
	c.insecureFollow = &http.Client{Transport: c.insecure, CheckRedirect: follow}
	return c
}

func (c *clients) get(insecure, follow bool) *http.Client {
	switch {
	case insecure && follow:
		return c.insecureFollow
	case insecure:
		return c.insecureNoFollow
	case follow:
		return c.secureFollow
	default:
		return c.secureNoFollow
	}
}

// wsClient returns a client for WebSocket handshakes. It gets its own
// transport so upgraded connections never sit in a shared idle pool.
func wsClient(insecure bool) *http.Client {
	return &http.Client{Transport: newTransport(insecure)}
}
