package netcfg

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"sync"
	"testing"
	"time"
)

type fakeLink struct {
	parent string
	vlan   int
	up     bool
	addrs  map[netip.Prefix]bool
}

type fakeOps struct {
	mu    sync.Mutex
	links map[string]*fakeLink
	log   []string
}

func newFake(nics ...string) *fakeOps {
	f := &fakeOps{links: map[string]*fakeLink{}}
	for _, n := range nics {
		f.links[n] = &fakeLink{addrs: map[netip.Prefix]bool{}}
	}
	return f
}
func (f *fakeOps) Link(n string) (bool, string, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	l, ok := f.links[n]
	if !ok {
		return false, "", 0, nil
	}
	return true, l.parent, l.vlan, nil
}
func (f *fakeOps) Usable(n string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if n == "lo" || n == "docker0" {
		return errors.New("virtual")
	}
	if _, ok := f.links[n]; !ok {
		return errors.New("not found")
	}
	return nil
}
func (f *fakeOps) AddVLAN(n, p string, v int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.links[n] = &fakeLink{parent: p, vlan: v, addrs: map[netip.Prefix]bool{}}
	f.log = append(f.log, "add "+n)
	return nil
}
func (f *fakeOps) SetUp(n string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.links[n].up = true
	return nil
}
func (f *fakeOps) Delete(n string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.links, n)
	f.log = append(f.log, "del "+n)
	return nil
}
func (f *fakeOps) ReplaceAddr(n string, p netip.Prefix, _ time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.links[n].addrs[p] = true
	return nil
}
func (f *fakeOps) DelAddr(n string, p netip.Prefix) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if l, ok := f.links[n]; ok {
		delete(l.addrs, p)
	}
	return nil
}
func (f *fakeOps) GlobalV4(n string) ([]netip.Prefix, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []netip.Prefix
	for p := range f.links[n].addrs {
		out = append(out, p)
	}
	return out, nil
}
func (f *fakeOps) Managed() ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for n, l := range f.links {
		if l.vlan > 0 {
			out = append(out, n)
		}
	}
	return out, nil
}

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestParseConfigValidation(t *testing.T) {
	good := `{"interfaces":[{"kind":"vlan","parent":"eth0","vlan":50,"mode":"dhcp"},{"kind":"existing","name":"eth1","mode":"static","address":"10.10.60.5/24"}]}`
	if _, err := ParseConfig(json.RawMessage(good)); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		`{"interfaces":[{"kind":"vlan","parent":"eth0","vlan":0,"mode":"dhcp"}]}`,
		`{"interfaces":[{"kind":"vlan","parent":"eth0;reboot","vlan":5,"mode":"dhcp"}]}`,
		`{"interfaces":[{"kind":"existing","name":"eth1","mode":"static","address":"8.8.8.8/24"}]}`,
		`{"interfaces":[{"kind":"existing","name":"scr50","mode":"dhcp"}]}`,
		`{"interfaces":[{"kind":"vlan","parent":"eth0","vlan":50,"mode":"dhcp"},{"kind":"vlan","parent":"eth1","vlan":50,"mode":"dhcp"}]}`,
		`{"interfaces":[{"kind":"vlan","parent":"eth0","vlan":50,"mode":"pppoe"}]}`,
	} {
		if _, err := ParseConfig(json.RawMessage(bad)); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
}

func TestApplyCreatesAcquiresAndRemoves(t *testing.T) {
	ops := newFake("eth0", "eth1")
	leases := make(chan string, 4)
	acq := func(ctx context.Context, n string, _ netip.Addr) (Lease, error) {
		leases <- n
		return Lease{Prefix: netip.MustParsePrefix("10.10.50.77/24"), Duration: time.Hour}, nil
	}
	m := New(ops, acq, quiet())
	defer m.Close()
	cfg, _ := ParseConfig(json.RawMessage(`{"interfaces":[{"kind":"vlan","parent":"eth0","vlan":50,"mode":"dhcp"},{"kind":"existing","name":"eth1","mode":"static","address":"10.10.60.5/24"}]}`))
	r := m.Apply(cfg)
	if len(r.Errors) != 0 {
		t.Fatal(r.Errors)
	}
	select {
	case n := <-leases:
		if n != "scr50" {
			t.Fatalf("dhcp on %s", n)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no dhcp")
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		st := m.Status()
		if len(st) == 2 && st[1].Name == "scr50" && st[1].State == "up" && st[1].Addrs[0] == "10.10.50.77/24" && st[0].Name == "eth1" && st[0].State == "up" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("status %+v", st)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !ops.links["scr50"].up || ops.links["scr50"].parent != "eth0" || ops.links["scr50"].vlan != 50 {
		t.Fatalf("link %+v", ops.links["scr50"])
	}
	// Drop both: VLAN deleted, our static address removed from eth1 (eth1 itself kept).
	m.Apply(Config{})
	if _, ok := ops.links["scr50"]; ok {
		t.Fatal("vlan not deleted")
	}
	if len(ops.links["eth1"].addrs) != 0 {
		t.Fatal("static address left on eth1")
	}
	if _, ok := ops.links["eth1"]; !ok {
		t.Fatal("existing NIC deleted")
	}
}

func TestRefusesHostConfiguredNICAndStrays(t *testing.T) {
	ops := newFake("eth0", "eth1")
	ops.links["eth1"].addrs[netip.MustParsePrefix("192.168.1.10/24")] = true
	ops.links["scr99"] = &fakeLink{parent: "eth0", vlan: 99, addrs: map[netip.Prefix]bool{}}
	m := New(ops, func(context.Context, string, netip.Addr) (Lease, error) { return Lease{}, errors.New("x") }, quiet())
	defer m.Close()
	cfg, _ := ParseConfig(json.RawMessage(`{"interfaces":[{"kind":"existing","name":"eth1","mode":"dhcp"}]}`))
	r := m.Apply(cfg)
	if len(r.Errors) != 1 || r.Interfaces[0].State != "error" {
		t.Fatalf("expected refusal, got %+v", r)
	}
	if _, ok := ops.links["scr99"]; ok {
		t.Fatal("stray scr99 not cleaned up")
	}
}

// Real DHCP against dnsmasq: set DHCP_TEST_IFACE to an unconfigured interface whose peer runs a DHCP server.
func TestAcquireLeaseReal(t *testing.T) {
	ifname := os.Getenv("DHCP_TEST_IFACE")
	if ifname == "" {
		t.Skip("set DHCP_TEST_IFACE to run against a real DHCP server")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	l, err := AcquireLease(ctx, ifname, netip.Addr{})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("lease %s from %s for %s", l.Prefix, l.Server, l.Duration)
	if !l.Prefix.Addr().IsPrivate() || l.Duration <= 0 {
		t.Fatalf("bad lease %+v", l)
	}
	// And apply it with real netlink.
	if err := (Netlink{}).ReplaceAddr(ifname, l.Prefix, l.Duration); err != nil {
		t.Fatal(err)
	}
	ifc, _ := net.InterfaceByName(ifname)
	addrs, _ := ifc.Addrs()
	found := false
	for _, a := range addrs {
		if a.String() == l.Prefix.String() {
			found = true
		}
	}
	if !found {
		t.Fatalf("address not applied: %v", addrs)
	}
	_ = (Netlink{}).DelAddr(ifname, l.Prefix)
}
