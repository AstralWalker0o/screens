package netx

import (
	"net/netip"
	"reflect"
	"strings"
	"testing"
	"time"
)

func pfx(s ...string) []netip.Prefix {
	var out []netip.Prefix
	for _, x := range s {
		out = append(out, netip.MustParsePrefix(x))
	}
	return out
}

func TestExpandListen(t *testing.T) {
	ifaces := []Iface{
		{Name: "lo", Up: true, Loopback: true, Prefixes: pfx("127.0.0.1/8", "::1/128")},
		{Name: "ens18", Up: true, Prefixes: pfx("192.168.1.5/24", "fe80::1/64", "2001:db8::5/64")},
		{Name: "ens18.20", Up: true, Prefixes: pfx("10.0.20.5/24", "fd00:20::5/64")},
		{Name: "docker0", Up: true, Prefixes: pfx("172.17.0.1/16")},
		{Name: "br-abc", Up: true, Prefixes: pfx("172.18.0.1/16")},
		{Name: "veth1", Up: true, Prefixes: pfx("169.254.3.3/16")},
		{Name: "tailscale0", Up: true, Prefixes: pfx("100.100.1.1/32")},
		{Name: "ens19", Up: false, Prefixes: pfx("10.9.9.9/24")},
	}
	got, bad := ExpandListen([]string{"0.0.0.0:53", "[::]:53", "10.1.1.1:5353", "bogus", "0.0.0.0:53"}, ifaces)
	want := []string{"10.0.20.5:53", "10.1.1.1:5353", "192.168.1.5:53", "[2001:db8::5]:53", "[fd00:20::5]:53"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	if !reflect.DeepEqual(bad, []string{"bogus"}) {
		t.Fatalf("bad %v", bad)
	}
}

func TestSkipped(t *testing.T) {
	for name, want := range map[string]bool{"lo": true, "docker0": true, "br-1": true, "veth9": true, "cni0": true, "flannel.1": true, "tailscale0": true, "ens18": false, "eth0.20": false, "bridge0": false} {
		if Skipped(name) != want {
			t.Errorf("%s", name)
		}
	}
}

func TestParseProcARP(t *testing.T) {
	in := `IP address       HW type     Flags       HW address            Mask     Device
10.0.20.31       0x1         0x2         BC:24:11:AA:BB:01     *        ens18.20
10.0.20.32       0x1         0x0         00:00:00:00:00:00     *        ens18.20
192.168.1.1      0x1         0x2         aa:bb:cc:dd:ee:ff     *        ens18
`
	got := ParseProcARP(strings.NewReader(in))
	want := []Neighbor{{"10.0.20.31", "bc:24:11:aa:bb:01", "ens18.20"}, {"192.168.1.1", "aa:bb:cc:dd:ee:ff", "ens18"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%v", got)
	}
}

func TestParseIPNeigh(t *testing.T) {
	in := `fe80::1 dev ens18 lladdr aa:bb:cc:dd:ee:ff router REACHABLE
fd00::9 dev ens18.20 lladdr 11:22:33:44:55:66 STALE
fe80::2 dev ens18 FAILED
fe80::3 dev ens18 lladdr 11:22:33:44:55:77 INCOMPLETE
`
	got := ParseIPNeigh(strings.NewReader(in))
	want := []Neighbor{{"fe80::1", "aa:bb:cc:dd:ee:ff", "ens18"}, {"fd00::9", "11:22:33:44:55:66", "ens18.20"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%v", got)
	}
}

func TestDirectedBroadcast(t *testing.T) {
	b, ok := DirectedBroadcast(netip.MustParsePrefix("10.0.20.5/24"))
	if !ok || b.String() != "10.0.20.255" {
		t.Fatal(b)
	}
	b, _ = DirectedBroadcast(netip.MustParsePrefix("10.0.16.1/22"))
	if b.String() != "10.0.19.255" {
		t.Fatal(b)
	}
	if _, ok := DirectedBroadcast(netip.MustParsePrefix("10.0.0.1/32")); ok {
		t.Fatal("/32")
	}
}

func TestOwnAddrs(t *testing.T) {
	o := NewOwnAddrs()
	o.Set(netip.MustParseAddr("10.0.20.5"), netip.MustParseAddr("fe80::1%eth0"))
	if !o.Contains(netip.MustParseAddr("::ffff:10.0.20.5")) || !o.Contains(netip.MustParseAddr("fe80::1")) || o.Contains(netip.MustParseAddr("10.0.20.6")) {
		t.Fatal("contains")
	}
}

func TestRateLimiter(t *testing.T) {
	l := NewRateLimiter(2)
	now := time.Unix(100, 0)
	if !l.Allow("a", now) || !l.Allow("a", now) || l.Allow("a", now) {
		t.Fatal("burst")
	}
	if !l.Allow("b", now) {
		t.Fatal("keys independent")
	}
	if l.Allow("a", now.Add(-time.Second)) {
		t.Fatal("clock going back must not refill")
	}
	if !l.Allow("a", now.Add(600*time.Millisecond)) {
		t.Fatal("refill")
	}
	l.SetRate(0)
	for i := 0; i < 100; i++ {
		if !l.Allow("a", now) {
			t.Fatal("unlimited")
		}
	}
}

func TestDedup(t *testing.T) {
	d := NewDedup(time.Second)
	now := time.Unix(100, 0)
	h := Hash([]byte("x"))
	if d.Seen(h, now) {
		t.Fatal("seen before add")
	}
	d.Add(h, now)
	if !d.Seen(h, now.Add(900*time.Millisecond)) || d.Seen(h, now.Add(time.Second)) {
		t.Fatal("window")
	}
}
