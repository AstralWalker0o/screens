package guard

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"

	"github.com/astralwalker0o/screens/gateway/internal/proto"
)

func code(err error) string {
	var pe *proto.Error
	if errors.As(err, &pe) {
		return pe.Code
	}
	if err == nil {
		return ""
	}
	return "?" + err.Error()
}

func TestIsAllowedAddr(t *testing.T) {
	cases := []struct {
		ip   string
		want bool
	}{
		{"10.0.20.31", true},
		{"10.255.255.255", true},
		{"172.16.0.1", true},
		{"172.31.255.254", true},
		{"172.15.255.255", false},
		{"172.32.0.1", false},
		{"192.168.1.10", true},
		{"192.169.0.1", false},
		{"100.64.0.1", true},
		{"100.127.255.255", true},
		{"100.128.0.1", false},
		{"169.254.1.1", true},
		{"fc00::1", true},
		{"fd12:3456::1", true},
		{"fe80::1", true},
		{"fe80::1%eth0", true},
		{"127.0.0.1", false},
		{"127.1.2.3", false},
		{"::1", false},
		{"::ffff:127.0.0.1", false},
		{"::ffff:10.0.0.1", true},
		{"::ffff:8.8.8.8", false},
		{"0.0.0.0", false},
		{"::", false},
		{"8.8.8.8", false},
		{"1.1.1.1", false},
		{"2606:4700::1111", false},
		{"224.0.0.251", false},
		{"239.255.255.250", false},
		{"ff02::fb", false},
		{"255.255.255.255", false},
		{"64:ff9b::a00:1", false}, // NAT64 of 10.0.0.1 is still not allowed
		{"2002:a00:1::", false},   // 6to4
		{"fec0::1", false},        // deprecated site-local
	}
	for _, c := range cases {
		a := netip.MustParseAddr(c.ip)
		if got := IsAllowedAddr(a); got != c.want {
			t.Errorf("IsAllowedAddr(%s) = %v, want %v", c.ip, got, c.want)
		}
	}
	if IsAllowedAddr(netip.Addr{}) {
		t.Error("zero addr allowed")
	}
}

func withLookup(t *testing.T, m map[string][]string) {
	t.Helper()
	prev := lookup
	lookup = func(ctx context.Context, host string) ([]netip.Addr, error) {
		v, ok := m[host]
		if !ok {
			return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
		}
		var out []netip.Addr
		for _, s := range v {
			out = append(out, netip.MustParseAddr(s))
		}
		return out, nil
	}
	t.Cleanup(func() { lookup = prev })
}

func TestResolve(t *testing.T) {
	withLookup(t, map[string][]string{
		"tv.lan":         {"10.0.20.40"},
		"dual.lan":       {"10.0.20.41", "fd00::41"},
		"localhost":      {"127.0.0.1", "::1"},
		"sneaky.lan":     {"10.0.20.42", "127.0.0.1"},
		"public.example": {"93.184.216.34"},
		"mixed.example":  {"10.0.0.5", "93.184.216.34"},
		"mapped.example": {"::ffff:127.0.0.1"},
		"zero.example":   {"0.0.0.0"},
		"empty.example":  {},
		"v6pub.example":  {"2606:4700::1111"},
	})
	cases := []struct {
		host string
		code string
	}{
		{"10.0.20.31", ""},
		{"[fe80::1]", ""},
		{"fe80::1%eth0", ""},
		{"tv.lan", ""},
		{"dual.lan", ""},
		{"127.0.0.1", proto.CodeForbidden},
		{"[::1]", proto.CodeForbidden},
		{"localhost", proto.CodeForbidden},
		{"sneaky.lan", proto.CodeForbidden},
		{"public.example", proto.CodeForbidden},
		{"mixed.example", proto.CodeForbidden},
		{"mapped.example", proto.CodeForbidden},
		{"zero.example", proto.CodeForbidden},
		{"v6pub.example", proto.CodeForbidden},
		{"8.8.8.8", proto.CodeForbidden},
		{"empty.example", proto.CodeUnreachable},
		{"nxdomain.example", proto.CodeUnreachable},
		{"", proto.CodeBadArgs},
	}
	for _, c := range cases {
		_, err := Resolve(context.Background(), c.host)
		if got := code(err); got != c.code {
			t.Errorf("Resolve(%q) code=%q want %q (err=%v)", c.host, got, c.code, err)
		}
	}
}

func TestCheckPrefix(t *testing.T) {
	cases := []struct {
		p  string
		ok bool
	}{
		{"10.0.20.0/24", true},
		{"10.0.0.0/8", true},
		{"192.168.0.0/16", true},
		{"192.168.0.0/15", false},
		{"172.16.0.0/11", false},
		{"0.0.0.0/0", false},
		{"8.8.8.0/24", false},
		{"127.0.0.0/8", false},
		{"fd00::/64", true},
		{"10.0.20.5/24", true}, // host bits are masked
	}
	for _, c := range cases {
		err := CheckPrefix(netip.MustParsePrefix(c.p))
		if (err == nil) != c.ok {
			t.Errorf("CheckPrefix(%s) err=%v want ok=%v", c.p, err, c.ok)
		}
	}
}

func TestLoopbackHook(t *testing.T) {
	lo := netip.MustParseAddr("127.0.0.1")
	if IsAllowedAddr(lo) {
		t.Fatal("loopback allowed by default")
	}
	restore := AllowLoopbackForTesting()
	if !IsAllowedAddr(lo) {
		t.Fatal("hook did not allow loopback")
	}
	if IsAllowedAddr(netip.MustParseAddr("8.8.8.8")) {
		t.Fatal("hook allowed a public address")
	}
	restore()
	if IsAllowedAddr(lo) {
		t.Fatal("restore did not disallow loopback")
	}
}

func TestDialerBlocksLoopbackService(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer srv.Close()
	addr := srv.Listener.Addr().String()

	d := Dialer{}
	if _, err := d.DialContext(context.Background(), "tcp", addr); code(err) != proto.CodeForbidden {
		t.Fatalf("dial loopback: got %v, want forbidden", err)
	}
	withLookup(t, map[string][]string{"rebind.lan": {"127.0.0.1"}})
	_, port, _ := net.SplitHostPort(addr)
	if _, err := d.DialContext(context.Background(), "tcp", net.JoinHostPort("rebind.lan", port)); code(err) != proto.CodeForbidden {
		t.Fatalf("dial hostname->loopback: got %v, want forbidden", err)
	}

	restore := AllowLoopbackForTesting()
	defer restore()
	c, err := d.DialContext(context.Background(), "tcp", addr)
	if err != nil {
		t.Fatalf("dial with hook: %v", err)
	}
	c.Close()
}

func TestControlCheck(t *testing.T) {
	if err := controlCheck("tcp4", "127.0.0.1:80", nil); code(err) != proto.CodeForbidden {
		t.Fatalf("control loopback: %v", err)
	}
	if err := controlCheck("tcp4", "10.1.2.3:80", nil); err != nil {
		t.Fatalf("control private: %v", err)
	}
	if err := controlCheck("tcp6", "[fe80::1%eth0]:80", nil); err != nil {
		t.Fatalf("control link-local zone: %v", err)
	}
	if err := controlCheck("tcp4", "1.2.3.4:80", nil); code(err) != proto.CodeForbidden {
		t.Fatalf("control public: %v", err)
	}
}

func TestDialBadArgs(t *testing.T) {
	d := Dialer{}
	for _, a := range []string{"10.0.0.1", "10.0.0.1:0", "10.0.0.1:70000", "10.0.0.1:x"} {
		if _, err := d.DialContext(context.Background(), "tcp", a); code(err) != proto.CodeBadArgs {
			t.Errorf("%s: got %v want bad_args", a, err)
		}
	}
}

func TestIsPrivateOrLoopback(t *testing.T) {
	for ip, want := range map[string]bool{"127.0.0.1": true, "10.1.1.1": true, "::1": true, "8.8.8.8": false, "fe80::1": true} {
		if got := IsPrivateOrLoopback(netip.MustParseAddr(ip)); got != want {
			t.Errorf("%s = %v", ip, got)
		}
	}
}
