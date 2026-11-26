package discovery

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"testing"
	"time"

	"github.com/miekg/dns"

	"github.com/astralwalker0o/screens/gateway/internal/guard"
	"github.com/astralwalker0o/screens/gateway/internal/netx"
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

func newDisc() *Discovery {
	own := netx.NewOwnAddrs()
	own.Set(netip.MustParseAddr("10.0.20.5"))
	d := New(own)
	d.Interfaces = func() []netx.Iface { return nil }
	return d
}

func TestHostsOf(t *testing.T) {
	if n := len(hostsOf(netip.MustParsePrefix("10.0.20.0/24"))); n != 254 {
		t.Fatal(n)
	}
	if h := hostsOf(netip.MustParsePrefix("10.0.20.4/30")); len(h) != 2 || h[0].String() != "10.0.20.5" {
		t.Fatal(h)
	}
	if h := hostsOf(netip.MustParsePrefix("10.0.20.4/31")); len(h) != 2 {
		t.Fatal(h)
	}
	if h := hostsOf(netip.MustParsePrefix("10.0.20.9/32")); len(h) != 1 || h[0].String() != "10.0.20.9" {
		t.Fatal(h)
	}
}

func TestDefaultScanPrefixes(t *testing.T) {
	ifs := []netx.Iface{
		{Name: "a", Prefixes: []netip.Prefix{netip.MustParsePrefix("10.0.20.5/24"), netip.MustParsePrefix("fd00::1/64")}},
		{Name: "b", Prefixes: []netip.Prefix{netip.MustParsePrefix("10.1.0.5/16")}},   // too big
		{Name: "c", Prefixes: []netip.Prefix{netip.MustParsePrefix("192.0.2.2/24")}},  // public
		{Name: "d", Prefixes: []netip.Prefix{netip.MustParsePrefix("10.2.4.1/22")}},   // ok
		{Name: "e", Prefixes: []netip.Prefix{netip.MustParsePrefix("10.0.20.77/24")}}, // dup
	}
	got := DefaultScanPrefixes(ifs)
	if len(got) != 2 || got[0].String() != "10.0.20.0/24" || got[1].String() != "10.2.4.0/22" {
		t.Fatal(got)
	}
}

func TestScanAndProbe(t *testing.T) {
	defer guard.AllowLoopbackForTesting()()
	d := newDisc()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<root><device><friendlyName>TV</friendlyName></device></root>`))
	}))
	defer srv.Close()
	_, portStr, _ := net.SplitHostPort(srv.Listener.Addr().String())
	port, _ := strconv.Atoi(portStr)
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	closed := ln.Addr().(*net.TCPAddr).Port
	ln.Close()

	res, err := d.Scan(context.Background(), json.RawMessage(`{"cidrs":["127.0.0.1/32"],"ports":[`+portStr+`,`+strconv.Itoa(closed)+`],"timeout_ms":300}`))
	if err != nil {
		t.Fatal(err)
	}
	hosts := res.(map[string]any)["hosts"].([]ScanHost)
	if len(hosts) != 1 || hosts[0].IP != "127.0.0.1" || len(hosts[0].OpenPorts) != 1 || hosts[0].OpenPorts[0] != port {
		t.Fatalf("hosts %+v", hosts)
	}
	for _, c := range []string{`{"cidrs":["8.8.8.0/24"]}`, `{"cidrs":["0.0.0.0/0"]}`} {
		if _, err := d.Scan(context.Background(), json.RawMessage(c)); code(err) != proto.CodeForbidden {
			t.Errorf("%s: %v", c, err)
		}
	}
	if _, err := d.Scan(context.Background(), json.RawMessage(`{"cidrs":["10.0.0.0/8"]}`)); code(err) != proto.CodeBadArgs {
		t.Errorf("huge: %v", err)
	}
	if _, err := d.Scan(context.Background(), json.RawMessage(`{"cidrs":["fd00::/120"]}`)); code(err) != proto.CodeBadArgs {
		t.Errorf("v6: %v", err)
	}

	res, err = d.Probe(context.Background(), json.RawMessage(`{"targets":[
	  {"id":"a","ip":"127.0.0.1","port":`+portStr+`,"kind":"tcp"},
	  {"id":"b","ip":"127.0.0.1","port":`+portStr+`,"kind":"http","path":"/dd.xml"},
	  {"id":"c","ip":"127.0.0.1","port":`+strconv.Itoa(closed)+`,"kind":"tcp","timeout_ms":300}]}`))
	if err != nil {
		t.Fatal(err)
	}
	rs := res.(map[string]any)["results"].([]ProbeResult)
	if !rs[0].OK || !rs[1].OK || *rs[1].Status != 200 || *rs[1].Body == "" || rs[2].OK {
		t.Fatalf("probe %+v", rs)
	}
	if _, err := d.Probe(context.Background(), json.RawMessage(`{"targets":[{"id":"x","ip":"1.1.1.1","port":80,"kind":"tcp"}]}`)); code(err) != proto.CodeForbidden {
		t.Fatalf("probe forbidden: %v", err)
	}
}

func TestWOL(t *testing.T) {
	mac, _ := net.ParseMAC("bc:24:11:aa:bb:cc")
	p := MagicPacket(mac)
	if len(p) != 102 || p[0] != 0xff || p[5] != 0xff || p[6] != 0xbc || p[101] != 0xcc {
		t.Fatalf("magic %x", p)
	}
	d := newDisc()
	if _, err := d.WOL(context.Background(), json.RawMessage(`{"mac":"bc:24:11:aa:bb:cc","broadcast":"8.8.8.8"}`)); code(err) != proto.CodeForbidden {
		t.Fatalf("public broadcast: %v", err)
	}
	if _, err := d.WOL(context.Background(), json.RawMessage(`{"mac":"nope"}`)); code(err) != proto.CodeBadArgs {
		t.Fatalf("bad mac: %v", err)
	}
	defer guard.AllowLoopbackForTesting()()
	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	port := pc.LocalAddr().(*net.UDPAddr).Port
	res, err := d.WOL(context.Background(), json.RawMessage(`{"mac":"bc:24:11:aa:bb:cc","broadcast":"127.0.0.1","port":`+strconv.Itoa(port)+`}`))
	if err != nil || res.(map[string]any)["sent"] != 1 {
		t.Fatalf("wol %v %v", res, err)
	}
	buf := make([]byte, 200)
	_ = pc.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, _, err := pc.ReadFrom(buf)
	if err != nil || n != 102 {
		t.Fatalf("received %d %v", n, err)
	}
}

func TestRecords(t *testing.T) {
	r := NewRecords()
	enum := new(dns.Msg)
	enum.Response = true
	enum.Answer = []dns.RR{&dns.PTR{Hdr: dns.RR_Header{Name: "_services._dns-sd._udp.local.", Rrtype: dns.TypePTR, Class: 1, Ttl: 10}, Ptr: "_googlecast._tcp.local."}}
	r.Add(enum)
	if ts := r.Types(); len(ts) != 1 || ts[0] != "_googlecast._tcp" {
		t.Fatal(ts)
	}
	ptr := new(dns.Msg)
	ptr.Response = true
	ptr.Answer = []dns.RR{&dns.PTR{Hdr: dns.RR_Header{Name: "_googlecast._tcp.local.", Rrtype: dns.TypePTR, Class: 1, Ttl: 10}, Ptr: "Living\\032Room._googlecast._tcp.local."}}
	r.Add(ptr)
	insts, _ := r.Missing()
	if len(insts) != 1 {
		t.Fatalf("missing %v", insts)
	}
	full := new(dns.Msg)
	full.Response = true
	full.Answer = []dns.RR{
		&dns.SRV{Hdr: dns.RR_Header{Name: "Living\\032Room._googlecast._tcp.local.", Rrtype: dns.TypeSRV, Class: 0x8001, Ttl: 10}, Port: 8009, Target: "cc-1.local."},
		&dns.TXT{Hdr: dns.RR_Header{Name: "living\\032room._googlecast._tcp.local.", Rrtype: dns.TypeTXT, Class: 0x8001, Ttl: 10}, Txt: []string{"md=Chromecast Ultra", "fn=Living\\032Room", "flag"}},
	}
	r.Add(full)
	if _, hosts := r.Missing(); len(hosts) != 1 || hosts[0] != "cc-1.local." {
		t.Fatalf("hosts %v", hosts)
	}
	a := new(dns.Msg)
	a.Response = true
	a.Answer = []dns.RR{&dns.A{Hdr: dns.RR_Header{Name: "CC-1.local.", Rrtype: dns.TypeA, Class: 1, Ttl: 10}, A: net.ParseIP("10.0.20.40")}}
	r.Add(a)
	es := r.Entries("vlan20", nil)
	if len(es) != 1 {
		t.Fatalf("%+v", es)
	}
	e := es[0]
	if e.Instance != "Living Room" || e.Service != "_googlecast._tcp" || e.Host != "cc-1.local" || e.Port != 8009 || len(e.Addrs) != 1 || e.TXT["md"] != "Chromecast Ultra" || e.TXT["fn"] != "Living Room" || e.Iface != "vlan20" {
		t.Fatalf("%+v", e)
	}
	if _, ok := e.TXT["flag"]; !ok {
		t.Fatal("boolean txt key")
	}
	if len(r.Entries("vlan20", map[string]bool{"_sonos._tcp": true})) != 0 {
		t.Fatal("service filter")
	}
}
