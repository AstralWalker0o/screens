package dnsd

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/miekg/dns"
)

// Upstreams resolves queries via DoH (RFC 8484 POST), trying each upstream in
// order with a per-attempt timeout, and falls back to plain UDP/TCP DNS when
// every DoH upstream fails. Upstreams that failed recently are tried last.
type Upstreams struct {
	mu       sync.Mutex
	urls     []string
	downTill map[string]time.Time

	Client   *http.Client
	Timeout  time.Duration
	Fallback string // host:port of the plain-DNS fallback
	OnError  func() // called once per failed upstream attempt
}

// BootstrapResolver resolves DoH upstream hostnames directly against
// 1.1.1.1 so the gateway never depends on itself (the host may use this
// gateway as its resolver).
var BootstrapResolver = &net.Resolver{
	PreferGo: true,
	Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, network, "1.1.1.1:53")
	},
}

// NewUpstreams creates a resolver with the protocol defaults.
func NewUpstreams() *Upstreams {
	dialer := &net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second, Resolver: BootstrapResolver}
	tr := &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		DialContext:         dialer.DialContext,
		ForceAttemptHTTP2:   true,
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     120 * time.Second,
		TLSHandshakeTimeout: 3 * time.Second,
	}
	return &Upstreams{
		downTill: map[string]time.Time{},
		Client:   &http.Client{Transport: tr},
		Timeout:  2 * time.Second,
		Fallback: "1.1.1.1:53",
	}
}

// SetURLs replaces the upstream list. Non-http(s) entries are returned as
// invalid and skipped.
func (u *Upstreams) SetURLs(urls []string) (invalid []string) {
	var ok []string
	for _, s := range urls {
		pu, err := url.Parse(s)
		if err != nil || (pu.Scheme != "https" && pu.Scheme != "http") || pu.Host == "" {
			invalid = append(invalid, s)
			continue
		}
		ok = append(ok, s)
	}
	u.mu.Lock()
	u.urls = ok
	u.mu.Unlock()
	return invalid
}

func (u *Upstreams) order(now time.Time) []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	var healthy, down []string
	for _, s := range u.urls {
		if t, ok := u.downTill[s]; ok && now.Before(t) {
			down = append(down, s)
		} else {
			healthy = append(healthy, s)
		}
	}
	return append(healthy, down...)
}

func (u *Upstreams) mark(s string, failed bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if failed {
		u.downTill[s] = time.Now().Add(30 * time.Second)
	} else {
		delete(u.downTill, s)
	}
}

func (u *Upstreams) failed() {
	if u.OnError != nil {
		u.OnError()
	}
}

// Exchange resolves q. The returned message has q's ID.
func (u *Upstreams) Exchange(ctx context.Context, q *dns.Msg) (*dns.Msg, error) {
	var lastErr error
	for _, s := range u.order(time.Now()) {
		r, err := u.doh(ctx, s, q)
		if err == nil {
			u.mark(s, false)
			r.Id = q.Id
			return r, nil
		}
		lastErr = fmt.Errorf("%s: %w", s, err)
		u.mark(s, true)
		u.failed()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	if u.Fallback == "" {
		if lastErr == nil {
			lastErr = errors.New("no upstreams")
		}
		return nil, lastErr
	}
	r, err := u.plain(ctx, q)
	if err != nil {
		u.failed()
		if lastErr != nil {
			return nil, fmt.Errorf("%v; fallback %s: %w", lastErr, u.Fallback, err)
		}
		return nil, err
	}
	r.Id = q.Id
	return r, nil
}

func (u *Upstreams) doh(ctx context.Context, endpoint string, q *dns.Msg) (*dns.Msg, error) {
	m := q.Copy()
	m.Id = 0
	wire, err := m.Pack()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, u.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(wire))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/dns-message")
	req.Header.Set("Accept", "application/dns-message")
	resp, err := u.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 65536))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "" && !strings.HasPrefix(ct, "application/dns-message") {
		return nil, fmt.Errorf("unexpected content-type %q", ct)
	}
	r := new(dns.Msg)
	if err := r.Unpack(body); err != nil {
		return nil, err
	}
	if !sameQuestion(q, r) {
		return nil, errors.New("response question mismatch")
	}
	return r, nil
}

func (u *Upstreams) plain(ctx context.Context, q *dns.Msg) (*dns.Msg, error) {
	m := q.Copy()
	m.Id = dns.Id()
	ctx, cancel := context.WithTimeout(ctx, u.Timeout)
	defer cancel()
	c := &dns.Client{Net: "udp", Timeout: u.Timeout, UDPSize: 4096}
	r, _, err := c.ExchangeContext(ctx, m, u.Fallback)
	if err == nil && r.Truncated {
		tc := &dns.Client{Net: "tcp", Timeout: u.Timeout}
		r, _, err = tc.ExchangeContext(ctx, m, u.Fallback)
	}
	if err != nil {
		return nil, err
	}
	if r.Id != m.Id || !sameQuestion(q, r) {
		return nil, errors.New("fallback response mismatch")
	}
	return r, nil
}

func sameQuestion(q, r *dns.Msg) bool {
	if len(q.Question) == 0 {
		return true
	}
	if len(r.Question) == 0 {
		// Some servers omit the question on errors; accept.
		return true
	}
	a, b := q.Question[0], r.Question[0]
	return a.Qtype == b.Qtype && a.Qclass == b.Qclass && strings.EqualFold(a.Name, b.Name)
}
