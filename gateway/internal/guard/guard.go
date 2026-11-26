// Package guard enforces the target-safety rule (PROTOCOL.md §4): relay and
// discovery primitives may only touch private / local addresses, never
// loopback, never public addresses. Hostnames are resolved and every resolved
// address must pass.
package guard

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/astralwalker0o/screens/gateway/internal/proto"
)

// allowedPrefixes are the only networks a relay target may be in.
var allowedPrefixes = []netip.Prefix{
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fe80::/10"),
}

var loopbackPrefixes = []netip.Prefix{
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("::1/128"),
}

// allowLoopback is a test-only escape hatch; see AllowLoopbackForTesting.
var allowLoopback atomic.Bool

// AllowLoopbackForTesting lets loopback targets pass the guard so tests can
// point relays at httptest servers on 127.0.0.1. Production code never calls
// it (nothing in cmd/ or the agent wiring does, and no env var enables it).
// It returns a function restoring the previous setting.
func AllowLoopbackForTesting() (restore func()) {
	prev := allowLoopback.Swap(true)
	return func() { allowLoopback.Store(prev) }
}

// LookupFunc resolves a hostname to addresses.
type LookupFunc func(ctx context.Context, host string) ([]netip.Addr, error)

// lookup is replaceable in tests.
var lookup LookupFunc = func(ctx context.Context, host string) ([]netip.Addr, error) {
	return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
}

// IsAllowedAddr reports whether a single address is an acceptable target.
func IsAllowedAddr(a netip.Addr) bool {
	if !a.IsValid() {
		return false
	}
	a = a.Unmap().WithZone("")
	if a.IsUnspecified() || a.IsMulticast() {
		return false
	}
	if a.IsLoopback() {
		return allowLoopback.Load()
	}
	for _, p := range allowedPrefixes {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// IsPrivateOrLoopback reports whether a is in the allowed set or is loopback.
// Used to decide which DNS clients may use the resolver (never as a relay
// target check).
func IsPrivateOrLoopback(a netip.Addr) bool {
	a = a.Unmap().WithZone("")
	if a.IsLoopback() {
		return true
	}
	for _, p := range allowedPrefixes {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

func forbidden(format string, args ...any) error {
	return proto.Errf(proto.CodeForbidden, format, args...)
}

// CheckAddr returns a forbidden error unless a is allowed.
func CheckAddr(a netip.Addr) error {
	if !IsAllowedAddr(a) {
		return forbidden("target %s is not a private/local address", a)
	}
	return nil
}

// ParseAddr parses an IP literal (optionally bracketed, optionally with zone).
func ParseAddr(s string) (netip.Addr, bool) {
	if len(s) >= 2 && s[0] == '[' && s[len(s)-1] == ']' {
		s = s[1 : len(s)-1]
	}
	a, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Addr{}, false
	}
	return a, true
}

// Resolve resolves host (an IP literal or a hostname) and checks every
// resulting address. It returns the addresses in resolver order.
func Resolve(ctx context.Context, host string) ([]netip.Addr, error) {
	if host == "" {
		return nil, proto.Errf(proto.CodeBadArgs, "empty host")
	}
	if a, ok := ParseAddr(host); ok {
		if err := CheckAddr(a); err != nil {
			return nil, err
		}
		return []netip.Addr{a}, nil
	}
	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	addrs, err := lookup(rctx, host)
	if err != nil {
		return nil, proto.Errf(proto.CodeUnreachable, "resolve %s: %v", host, err)
	}
	if len(addrs) == 0 {
		return nil, proto.Errf(proto.CodeUnreachable, "resolve %s: no addresses", host)
	}
	for _, a := range addrs {
		if !IsAllowedAddr(a) {
			return nil, forbidden("%s resolves to %s, which is not a private/local address", host, a.Unmap())
		}
	}
	return addrs, nil
}

// CheckPrefix verifies that a whole network lies within an allowed range.
func CheckPrefix(p netip.Prefix) error {
	if !p.IsValid() {
		return proto.Errf(proto.CodeBadArgs, "invalid prefix")
	}
	p = p.Masked()
	ranges := allowedPrefixes
	if allowLoopback.Load() {
		ranges = append(append([]netip.Prefix{}, allowedPrefixes...), loopbackPrefixes...)
	}
	for _, q := range ranges {
		if q.Bits() <= p.Bits() && q.Contains(p.Addr()) {
			return nil
		}
	}
	return forbidden("network %s is not inside a private/local range", p)
}

// controlCheck runs at connect time on the actual remote address, so a
// hostname that changes between Resolve and dial cannot slip through.
func controlCheck(network, address string, _ syscall.RawConn) error {
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		host, _, serr := net.SplitHostPort(address)
		if serr != nil {
			return forbidden("unparseable dial address %q", address)
		}
		a, ok := ParseAddr(host)
		if !ok {
			return forbidden("unparseable dial address %q", address)
		}
		return CheckAddr(a)
	}
	return CheckAddr(ap.Addr())
}

// Dialer dials TCP connections to guarded targets.
type Dialer struct {
	Timeout time.Duration
}

// DialContext resolves and checks the host, then dials each address in turn.
// Connection failures are reported with code "unreachable".
func (d Dialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, portStr, err := net.SplitHostPort(address)
	if err != nil {
		return nil, proto.Errf(proto.CodeBadArgs, "bad address %q: %v", address, err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		return nil, proto.Errf(proto.CodeBadArgs, "bad port in %q", address)
	}
	addrs, err := Resolve(ctx, host)
	if err != nil {
		return nil, err
	}
	nd := net.Dialer{Timeout: d.Timeout, Control: controlCheck, KeepAlive: 30 * time.Second}
	var lastErr error
	for _, a := range addrs {
		c, err := nd.DialContext(ctx, network, netip.AddrPortFrom(a, uint16(port)).String())
		if err == nil {
			return c, nil
		}
		lastErr = err
		if ctx.Err() != nil {
			break
		}
	}
	return nil, DialError(lastErr)
}

// DialError maps a dial error to a protocol error.
func DialError(err error) error {
	if err == nil {
		return nil
	}
	var pe *proto.Error
	if errors.As(err, &pe) {
		return pe
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return proto.Errf(proto.CodeTimeout, "%v", err)
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return proto.Errf(proto.CodeUnreachable, "%v", err)
	}
	return proto.Errf(proto.CodeUnreachable, "%v", err)
}

// HostPort validates "ip:port" or "host:port" and returns the parts.
func HostPort(s string) (string, int, error) {
	host, portStr, err := net.SplitHostPort(s)
	if err != nil {
		return "", 0, proto.Errf(proto.CodeBadArgs, "expected host:port, got %q", s)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		return "", 0, proto.Errf(proto.CodeBadArgs, "bad port in %q", s)
	}
	return host, port, nil
}
