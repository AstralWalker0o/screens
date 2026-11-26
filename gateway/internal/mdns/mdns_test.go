package mdns

import (
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"testing"
	"time"

	"github.com/miekg/dns"

	"github.com/astralwalker0o/screens/gateway/internal/netx"
)

func query(names ...string) *dns.Msg {
	m := new(dns.Msg)
	for _, n := range names {
		m.Question = append(m.Question, dns.Question{Name: dns.Fqdn(n), Qtype: dns.TypePTR, Qclass: dns.ClassINET})
	}
	return m
}

func hdr(name string, t uint16, ttl uint32) dns.RR_Header {
	return dns.RR_Header{Name: dns.Fqdn(name), Rrtype: t, Class: dns.ClassINET | 0x8000, Ttl: ttl}
}

// announce builds a typical DNS-SD response for one instance.
func announce(service, instance, host, ip string, port uint16, ttl uint32) *dns.Msg {
	full := instance + "." + service + ".local."
	m := new(dns.Msg)
	m.Response = true
	m.Authoritative = true
	m.Answer = []dns.RR{&dns.PTR{Hdr: dns.RR_Header{Name: service + ".local.", Rrtype: dns.TypePTR, Class: dns.ClassINET, Ttl: ttl}, Ptr: full}}
	m.Extra = []dns.RR{
		&dns.SRV{Hdr: hdr(full, dns.TypeSRV, ttl), Port: port, Target: host + ".local."},
		&dns.TXT{Hdr: hdr(full, dns.TypeTXT, ttl), Txt: []string{"md=Chromecast", "fn=Living Room"}},
		&dns.A{Hdr: hdr(host+".local", dns.TypeA, ttl), A: net.ParseIP(ip)},
	}
	return m
}

func TestServiceType(t *testing.T) {
	cases := map[string]string{
		"_googlecast._tcp.local.":                   "_googlecast._tcp",
		"Living\\032Room._googlecast._tcp.local.":   "_googlecast._tcp",
		"_printer._sub._http._tcp.local.":           "_http._tcp",
		"_services._dns-sd._udp.local.":             "_dns-sd._udp",
		"_Sonos._TCP.local.":                        "_sonos._tcp",
		"chromecast-abc.local.":                     "",
		"5.20.0.10.in-addr.arpa.":                   "",
		"weird\\._tcp.local.":                       "",
		"Foo\\._tcp._airplay._tcp.local.":           "_airplay._tcp",
		"_spotify-connect._tcp.local":               "_spotify-connect._tcp",
		"notservice._tcp.local.":                    "",
		"My TV._androidtvremote2._tcp.local.":       "_androidtvremote2._tcp",
		"B8E937AB1234@Office._raop._tcp.local.":     "_raop._tcp",
		"Office._sonos._tcp.local.":                 "_sonos._tcp",
		"_matter._tcp.default.service.arpa.":        "_matter._tcp",
		"inst._hap._udp.local.":                     "_hap._udp",
		"x.y.local.":                                "",
		"":                                          "",
		"_tcp.local.":                               "",
		"_x._tcp._y._udp.local.":                    "_y._udp",
		"Sonos-Kitchen\\.Speaker._sonos._tcp.local": "_sonos._tcp",
	}
	for in, want := range cases {
		if got := ServiceType(in); got != want {
			t.Errorf("ServiceType(%q) = %q want %q", in, got, want)
		}
	}
}

func TestMatch(t *testing.T) {
	media := CompileRule("ens18.20", []string{"ens18"}, []string{"_sonos._tcp", "_googlecast._tcp.local.", "_airplay._tcp"}, nil)
	all := CompileRule("ens18", []string{"ens18.20"}, []string{"*"}, []string{"_hap._tcp"})
	none := func(string, Rule) bool { return false }

	cases := []struct {
		name string
		m    *dns.Msg
		r    Rule
		want bool
	}{
		{"allowed query", query("_googlecast._tcp.local"), media, true},
		{"other query", query("_printer._tcp.local"), media, false},
		{"mixed query has one allowed", query("_printer._tcp.local", "_sonos._tcp.local"), media, true},
		{"allowed announce", announce("_googlecast._tcp", "Living\\032Room", "cc-1", "10.0.20.40", 8009, 120), media, true},
		{"denied type", announce("_hap._tcp", "Bridge", "hue", "10.0.20.50", 8080, 120), all, false},
		{"wildcard", announce("_ipp._tcp", "Printer", "prn", "10.0.20.60", 631, 120), all, true},
		{"denied even with other allowed", query("_airplay._tcp.local", "_hap._tcp.local"), all, false},
		{"host query with *", hostQuery("cc-1.local"), all, true},
		{"host query unseen", hostQuery("cc-1.local"), media, false},
		{"empty", new(dns.Msg), all, false},
		{"enumeration not allowed by list", query("_services._dns-sd._udp.local"), media, false},
	}
	for _, c := range cases {
		if got := Match(c.m, c.r, none); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}

	// Enumeration response: PTR targets carry the service types.
	enum := new(dns.Msg)
	enum.Response = true
	enum.Answer = []dns.RR{&dns.PTR{Hdr: hdr("_services._dns-sd._udp.local", dns.TypePTR, 120), Ptr: "_sonos._tcp.local."}}
	withEnum := CompileRule("a", []string{"b"}, []string{"_dns-sd._udp", "_sonos._tcp"}, nil)
	if !Match(enum, withEnum, none) {
		t.Error("enumeration response with allowed target")
	}
	enum.Answer = append(enum.Answer, &dns.PTR{Hdr: hdr("_services._dns-sd._udp.local", dns.TypePTR, 120), Ptr: "_hap._tcp.local."})
	if Match(enum, CompileRule("a", nil, []string{"*"}, []string{"_hap._tcp"}), none) {
		t.Error("enumeration listing a denied type must be dropped")
	}
}

func hostQuery(host string) *dns.Msg {
	m := new(dns.Msg)
	m.Question = []dns.Question{{Name: dns.Fqdn(host), Qtype: dns.TypeA, Qclass: dns.ClassINET}}
	return m
}

func TestHostnameFollowsSRV(t *testing.T) {
	tr := NewTracker()
	now := time.Unix(10000, 0)
	media := CompileRule("ens18", []string{"ens18.20"}, []string{"_googlecast._tcp"}, nil)
	q := hostQuery("cc-1.local")
	if Match(q, media, tr.HostSeen(now)) {
		t.Fatal("unseen host matched")
	}
	// An SRV for an allowed service pointing at cc-1.local is seen.
	tr.ObserveSRV(announce("_googlecast._tcp", "TV", "cc-1", "10.0.20.40", 8009, 120), now)
	if !Match(q, media, tr.HostSeen(now.Add(time.Minute))) {
		t.Fatal("seen host not matched")
	}
	// The A answer (with a reverse PTR) also passes.
	ans := new(dns.Msg)
	ans.Response = true
	ans.Answer = []dns.RR{&dns.A{Hdr: hdr("cc-1.local", dns.TypeA, 120), A: net.ParseIP("10.0.20.40")}}
	ans.Extra = []dns.RR{&dns.PTR{Hdr: hdr("40.20.0.10.in-addr.arpa", dns.TypePTR, 120), Ptr: "cc-1.local."}}
	if !Match(ans, media, tr.HostSeen(now.Add(time.Minute))) {
		t.Fatal("host answer not matched")
	}
	// A different host in the same packet blocks it.
	q2 := hostQuery("cc-1.local")
	q2.Question = append(q2.Question, dns.Question{Name: "other.local.", Qtype: dns.TypeA, Qclass: dns.ClassINET})
	if Match(q2, media, tr.HostSeen(now)) {
		t.Fatal("packet with unseen host matched")
	}
	// Seen only for a service this rule doesn't allow.
	other := CompileRule("ens18", nil, []string{"_sonos._tcp"}, nil)
	if Match(q, other, tr.HostSeen(now)) {
		t.Fatal("host seen for another service matched")
	}
	// Window expiry.
	if Match(q, media, tr.HostSeen(now.Add(11*time.Minute))) {
		t.Fatal("expired host matched")
	}
}

func TestClearQU(t *testing.T) {
	q := query("_googlecast._tcp.local")
	q.Question[0].Qclass |= 0x8000
	raw, _ := q.Pack()
	m := new(dns.Msg)
	_ = m.Unpack(raw)
	out, changed := PrepareForReflection(m, raw)
	if !changed {
		t.Fatal("QU not cleared")
	}
	m2 := new(dns.Msg)
	if err := m2.Unpack(out); err != nil {
		t.Fatal(err)
	}
	if m2.Question[0].Qclass != dns.ClassINET {
		t.Fatalf("qclass %x", m2.Question[0].Qclass)
	}
	if m.Question[0].Qclass&0x8000 == 0 {
		t.Fatal("original message mutated")
	}
	// QM query and responses pass unchanged.
	q.Question[0].Qclass = dns.ClassINET
	raw, _ = q.Pack()
	_ = m.Unpack(raw)
	if out, changed := PrepareForReflection(m, raw); changed || &out[0] != &raw[0] {
		t.Fatal("QM query changed")
	}
	resp := announce("_sonos._tcp", "Kitchen", "sonos-1", "10.0.20.70", 1400, 120)
	raw, _ = resp.Pack()
	_ = m.Unpack(raw)
	if _, changed := PrepareForReflection(m, raw); changed {
		t.Fatal("response changed (cache-flush bits must survive)")
	}
}

func testReflector(t *testing.T, cfg string) (*Reflector, *netx.OwnAddrs) {
	own := netx.NewOwnAddrs()
	own.Set(netip.MustParseAddr("10.0.20.5"), netip.MustParseAddr("192.168.1.5"))
	r := New(slog.New(slog.NewTextHandler(io.Discard, nil)), own)
	t.Cleanup(r.Close)
	c, err := ParseConfig(json.RawMessage(cfg))
	if err != nil {
		t.Fatal(err)
	}
	r.Apply(c) // interfaces do not exist here; only the rules matter for Decide
	return r, own
}

func TestDecidePipeline(t *testing.T) {
	r, _ := testReflector(t, `{"enabled":true,"interfaces":["vlan20","lan"],"rate_limit_pps":5,
	  "rules":[{"from":"vlan20","to":["lan"],"allow":["_googlecast._tcp","_sonos._tcp"]},
	           {"from":"lan","to":["vlan20"],"allow":["*"],"deny":["_hap._tcp"]}]}`)
	now := time.Unix(20000, 0)
	pack := func(m *dns.Msg) []byte { b, _ := m.Pack(); return b }

	a := pack(announce("_googlecast._tcp", "TV", "cc-1", "10.0.20.40", 8009, 120))
	d := r.Decide("vlan20", a, netip.MustParseAddr("10.0.20.40"), now)
	if d.Drop != "" || len(d.To) != 1 || d.To[0] != "lan" {
		t.Fatalf("announce: %+v", d)
	}
	// Same content within 1 s is a duplicate (loop prevention).
	if d := r.Decide("lan", a, netip.MustParseAddr("192.168.1.1"), now.Add(500*time.Millisecond)); d.Drop != "dup" {
		t.Fatalf("dup: %+v", d)
	}
	if d := r.Decide("vlan20", a, netip.MustParseAddr("10.0.20.40"), now.Add(1500*time.Millisecond)); d.Drop != "" {
		t.Fatalf("after window: %+v", d)
	}
	// Own source address is never reflected.
	if d := r.Decide("lan", pack(query("_x._tcp.local")), netip.MustParseAddr("192.168.1.5"), now); d.Drop != "own" {
		t.Fatalf("own: %+v", d)
	}
	// Not allowed on vlan20 → lan.
	if d := r.Decide("vlan20", pack(query("_printer._tcp.local")), netip.MustParseAddr("10.0.20.41"), now); d.Drop != "nomatch" {
		t.Fatalf("filtered: %+v", d)
	}
	// Deny on lan → vlan20.
	if d := r.Decide("lan", pack(query("_hap._tcp.local")), netip.MustParseAddr("192.168.1.20"), now); d.Drop != "nomatch" {
		t.Fatalf("deny: %+v", d)
	}
	// QU query from lan is reflected with QU cleared.
	q := query("_googlecast._tcp.local")
	q.Question[0].Qclass |= 0x8000
	d = r.Decide("lan", pack(q), netip.MustParseAddr("192.168.1.20"), now)
	if d.Drop != "" {
		t.Fatalf("qu query: %+v", d)
	}
	out := new(dns.Msg)
	_ = out.Unpack(d.Payload)
	if out.Question[0].Qclass != dns.ClassINET {
		t.Fatal("QU bit not cleared")
	}
	// Unknown source interface has no rules.
	q.Id = 999
	if d := r.Decide("eth9", pack(q), netip.MustParseAddr("10.9.9.9"), now); d.Drop != "nomatch" {
		t.Fatalf("no rules: %+v", d)
	}
	// Garbage.
	if d := r.Decide("lan", []byte{1, 2, 3}, netip.MustParseAddr("192.168.1.20"), now); d.Drop != "parse" {
		t.Fatalf("parse: %+v", d)
	}
	// Rate limit: 5 pps per interface.
	later := now.Add(time.Hour)
	drops := 0
	for i := 0; i < 10; i++ {
		qq := query("_sonos._tcp.local")
		qq.Id = uint16(i + 1)
		if d := r.Decide("vlan20", pack(qq), netip.MustParseAddr("10.0.20.41"), later); d.Drop == "rate" {
			drops++
		}
	}
	if drops != 5 {
		t.Fatalf("rate limited %d of 10", drops)
	}
	// Tracker saw the announce.
	svcs := r.Tracker().List(now)
	if len(svcs) != 1 || svcs[0].Instance != "TV" || svcs[0].Host != "cc-1.local" || svcs[0].Port != 8009 || svcs[0].Iface != "vlan20" || len(svcs[0].Addrs) != 1 || svcs[0].Addrs[0] != "10.0.20.40" {
		t.Fatalf("tracker %+v", svcs)
	}
}

func TestTracker(t *testing.T) {
	tr := NewTracker()
	now := time.Unix(30000, 0)
	tr.Observe("vlan20", announce("_sonos._tcp", "Living\\032Room", "sonos-1", "10.0.20.70", 1400, 4500), now)
	tr.Observe("vlan20", announce("_googlecast._tcp", "TV", "cc-1", "10.0.20.40", 8009, 120), now)
	tr.Observe("vlan20", query("_sonos._tcp.local"), now) // queries are ignored
	list := tr.List(now)
	if len(list) != 2 || list[0].Service != "_googlecast._tcp" || list[1].Instance != "Living Room" || list[1].LastSeen != now.UnixMilli() {
		t.Fatalf("%+v", list)
	}
	fp := Fingerprint(list)
	tr.Observe("vlan20", announce("_sonos._tcp", "Living\\032Room", "sonos-1", "10.0.20.70", 1400, 4500), now.Add(time.Second))
	if Fingerprint(tr.List(now.Add(time.Second))) != fp {
		t.Fatal("fingerprint changed with only last_seen")
	}
	// Goodbye (TTL 0) removes the instance.
	tr.Observe("vlan20", announce("_googlecast._tcp", "TV", "cc-1", "10.0.20.40", 8009, 0), now)
	if l := tr.List(now); len(l) != 1 {
		t.Fatalf("goodbye: %+v", l)
	}
	// Expiry.
	tr.Expire(now.Add(3 * time.Hour))
	if l := tr.List(now.Add(3 * time.Hour)); len(l) != 0 {
		t.Fatalf("expire: %+v", l)
	}
}

func TestUnescapeAndLabels(t *testing.T) {
	if Unescape(`Living\032Room`) != "Living Room" || Unescape(`a\.b`) != "a.b" || Unescape(`x\"y`) != `x"y` {
		t.Fatal("unescape")
	}
	if InstanceLabel(`My\.TV._googlecast._tcp.local.`, "_googlecast._tcp") != "My.TV" {
		t.Fatal("instance label")
	}
	if NormalizeType("_Sonos._tcp.local.") != "_sonos._tcp" {
		t.Fatal("normalize")
	}
}

func TestParseConfigDefaults(t *testing.T) {
	c, err := ParseConfig(json.RawMessage(`{"enabled":true}`))
	if err != nil || c.RateLimitPPS != 200 || !c.TrackServices {
		t.Fatalf("%+v %v", c, err)
	}
	if _, err := ParseConfig(json.RawMessage(`{"rules":[{"to":["x"]}]}`)); err == nil {
		t.Fatal("rule without from accepted")
	}
}

func TestDenyStripsRecordsNotPacket(t *testing.T) {
	r, _ := testReflector(t, `{"enabled":true,"interfaces":["vlan20","lan"],
	  "rules":[{"from":"vlan20","to":["lan"],"allow":["*"],"deny":["_hap._tcp"]}]}`)
	now := time.Unix(30000, 0)
	// An Apple TV announces AirPlay and HomeKit in one packet.
	m := new(dns.Msg)
	m.Response, m.Authoritative = true, true
	hdr := func(name string, t uint16) dns.RR_Header {
		return dns.RR_Header{Name: name, Rrtype: t, Class: dns.ClassINET | 0x8000, Ttl: 120}
	}
	m.Answer = []dns.RR{
		&dns.PTR{Hdr: hdr("_airplay._tcp.local.", dns.TypePTR), Ptr: "Lounge._airplay._tcp.local."},
		&dns.PTR{Hdr: hdr("_hap._tcp.local.", dns.TypePTR), Ptr: "Lounge._hap._tcp.local."},
		&dns.SRV{Hdr: hdr("Lounge._airplay._tcp.local.", dns.TypeSRV), Port: 7000, Target: "Lounge.local."},
		&dns.SRV{Hdr: hdr("Lounge._hap._tcp.local.", dns.TypeSRV), Port: 49152, Target: "Lounge.local."},
	}
	m.Extra = []dns.RR{&dns.A{Hdr: hdr("Lounge.local.", dns.TypeA), A: net.ParseIP("10.0.20.60").To4()}}
	b, _ := m.Pack()
	d := r.Decide("vlan20", b, netip.MustParseAddr("10.0.20.60"), now)
	if d.Drop != "" || len(d.To) != 1 {
		t.Fatalf("mixed packet should be reflected: %+v", d)
	}
	out := new(dns.Msg)
	if err := out.Unpack(d.PayloadFor("lan")); err != nil {
		t.Fatal(err)
	}
	for _, rr := range append(out.Answer, out.Extra...) {
		if ServiceType(rr.Header().Name) == "_hap._tcp" {
			t.Fatalf("denied record leaked: %s", rr)
		}
	}
	if len(out.Answer) != 2 || len(out.Extra) != 1 {
		t.Fatalf("expected airplay PTR+SRV and host A to remain, got %d answers %d extra", len(out.Answer), len(out.Extra))
	}
	// A packet that is only the denied service is still dropped.
	q := new(dns.Msg)
	q.SetQuestion("_hap._tcp.local.", dns.TypePTR)
	qb, _ := q.Pack()
	if d := r.Decide("vlan20", qb, netip.MustParseAddr("10.0.20.61"), now); d.Drop != "nomatch" {
		t.Fatalf("pure denied query should be dropped: %+v", d)
	}
}
