package discovery

import (
	"context"
	"encoding/json"
	"net"
	"net/netip"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/miekg/dns"
	"golang.org/x/net/ipv4"

	"github.com/astralwalker0o/screens/gateway/internal/mdns"
	"github.com/astralwalker0o/screens/gateway/internal/netx"
	"github.com/astralwalker0o/screens/gateway/internal/ops"
	"github.com/astralwalker0o/screens/gateway/internal/ssdp"
)

// BrowseEntry is one net.mdns_browse result.
type BrowseEntry struct {
	Instance string            `json:"instance"`
	Service  string            `json:"service"`
	Host     string            `json:"host"`
	Addrs    []string          `json:"addrs"`
	Port     int               `json:"port"`
	TXT      map[string]string `json:"txt"`
	Iface    string            `json:"iface"`
}

type srvRec struct {
	target string
	port   int
}

// Records accumulates mDNS answers for one interface.
type Records struct {
	mu        sync.Mutex
	types     map[string]bool            // from _services._dns-sd._udp
	instances map[string]map[string]bool // service type → instance full names (lower → original kept in names)
	names     map[string]string          // lower → original instance name
	srv       map[string]srvRec
	txt       map[string][]string
	addrs     map[string]map[string]bool
}

// NewRecords creates an empty store.
func NewRecords() *Records {
	return &Records{types: map[string]bool{}, instances: map[string]map[string]bool{}, names: map[string]string{}, srv: map[string]srvRec{}, txt: map[string][]string{}, addrs: map[string]map[string]bool{}}
}

// Add records every RR of a response.
func (r *Records) Add(m *dns.Msg) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, sec := range [][]dns.RR{m.Answer, m.Ns, m.Extra} {
		for _, rr := range sec {
			h := rr.Header()
			owner := strings.ToLower(h.Name)
			switch v := rr.(type) {
			case *dns.PTR:
				st := mdns.ServiceType(h.Name)
				if st == "_dns-sd._udp" {
					if t := mdns.ServiceType(v.Ptr); t != "" {
						r.types[t] = true
					}
					continue
				}
				if st == "" || mdns.ServiceType(v.Ptr) != st {
					continue
				}
				inst := strings.ToLower(v.Ptr)
				if strings.HasPrefix(inst, st+".") {
					continue
				}
				if r.instances[st] == nil {
					r.instances[st] = map[string]bool{}
				}
				r.instances[st][inst] = true
				r.names[inst] = v.Ptr
			case *dns.SRV:
				r.srv[owner] = srvRec{target: v.Target, port: int(v.Port)}
				if st := mdns.ServiceType(h.Name); st != "" {
					if r.instances[st] == nil {
						r.instances[st] = map[string]bool{}
					}
					r.instances[st][owner] = true
					if _, ok := r.names[owner]; !ok {
						r.names[owner] = h.Name
					}
				}
			case *dns.TXT:
				r.txt[owner] = v.Txt
			case *dns.A:
				r.addAddr(owner, v.A.String())
			case *dns.AAAA:
				r.addAddr(owner, v.AAAA.String())
			}
		}
	}
}

func (r *Records) addAddr(host, a string) {
	if r.addrs[host] == nil {
		r.addrs[host] = map[string]bool{}
	}
	r.addrs[host][a] = true
}

// Types returns service types learned from enumeration.
func (r *Records) Types() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for t := range r.types {
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

// Missing returns names needing follow-up queries: instances lacking SRV
// or TXT, and SRV targets lacking addresses.
func (r *Records) Missing() (instances, hosts []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, set := range r.instances {
		for inst := range set {
			_, hasSRV := r.srv[inst]
			_, hasTXT := r.txt[inst]
			if !hasSRV || !hasTXT {
				instances = append(instances, r.names[inst])
			}
			if s, ok := r.srv[inst]; ok && len(r.addrs[strings.ToLower(s.target)]) == 0 {
				hosts = append(hosts, s.target)
			}
		}
	}
	return instances, hosts
}

// ParseTXT turns DNS-SD TXT strings into a map.
func ParseTXT(txt []string) map[string]string {
	out := map[string]string{}
	for _, s := range txt {
		s = mdns.Unescape(s)
		if s == "" {
			continue
		}
		k, v, _ := strings.Cut(s, "=")
		if _, dup := out[k]; !dup {
			out[k] = v
		}
	}
	return out
}

// Entries assembles results, restricted to services if non-empty.
func (r *Records) Entries(iface string, services map[string]bool) []BrowseEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []BrowseEntry
	for st, set := range r.instances {
		if len(services) > 0 && !services[st] {
			continue
		}
		for inst := range set {
			e := BrowseEntry{Service: st, Instance: mdns.InstanceLabel(r.names[inst], st), Addrs: []string{}, TXT: ParseTXT(r.txt[inst]), Iface: iface}
			if s, ok := r.srv[inst]; ok {
				e.Host = mdns.Unescape(mdns.TrimDot(s.target))
				e.Port = s.port
				for a := range r.addrs[strings.ToLower(s.target)] {
					e.Addrs = append(e.Addrs, a)
				}
				sort.Strings(e.Addrs)
			}
			out = append(out, e)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Service != out[j].Service {
			return out[i].Service < out[j].Service
		}
		return out[i].Instance < out[j].Instance
	})
	return out
}

func fqdnService(s string) string {
	s = mdns.NormalizeType(s)
	if s == "" {
		return ""
	}
	return s + ".local."
}

type browseSock struct {
	iface string
	conn  *net.UDPConn
	recs  *Records
}

func (d *Discovery) openSockets(ctx context.Context, ttl int) []*browseSock {
	var out []*browseSock
	for _, i := range d.Interfaces() {
		if !i.Multicast {
			continue
		}
		addr, ok := i.FirstIPv4()
		if !ok {
			continue
		}
		c, err := netx.ListenUDP(ctx, "udp4", netip.AddrPortFrom(addr, 0).String(), i.Name, false)
		if err != nil {
			continue
		}
		pc := ipv4.NewPacketConn(c)
		if ifi, err := net.InterfaceByIndex(i.Index); err == nil {
			_ = pc.SetMulticastInterface(ifi)
		}
		_ = pc.SetMulticastTTL(ttl)
		_ = pc.SetMulticastLoopback(false)
		out = append(out, &browseSock{iface: i.Name, conn: c, recs: NewRecords()})
	}
	return out
}

func durationArg(ctx context.Context, ms int64) time.Duration {
	d := time.Duration(ops.MsOr(ms, 3000, 30000)) * time.Millisecond
	if dl, ok := ctx.Deadline(); ok {
		if left := time.Until(dl) - 250*time.Millisecond; left < d {
			d = left
		}
	}
	if d < 100*time.Millisecond {
		d = 100 * time.Millisecond
	}
	return d
}

// MDNSBrowse implements net.mdns_browse using one-shot (legacy unicast)
// queries from an ephemeral port on every multicast-capable interface.
func (d *Discovery) MDNSBrowse(ctx context.Context, raw json.RawMessage) (any, error) {
	var a struct {
		Services   []string `json:"services"`
		DurationMs int64    `json:"duration_ms"`
	}
	if err := ops.Decode(raw, &a); err != nil {
		return nil, err
	}
	dur := durationArg(ctx, a.DurationMs)
	start := time.Now()
	deadline := start.Add(dur)
	socks := d.openSockets(ctx, 255)
	defer func() {
		for _, s := range socks {
			s.conn.Close()
		}
	}()
	var wg sync.WaitGroup
	for _, s := range socks {
		_ = s.conn.SetReadDeadline(deadline)
		wg.Add(1)
		go func(s *browseSock) {
			defer wg.Done()
			buf := make([]byte, 9000)
			for {
				n, _, err := s.conn.ReadFromUDPAddrPort(buf)
				if err != nil {
					return
				}
				m := new(dns.Msg)
				if m.Unpack(buf[:n]) == nil && m.Response {
					s.recs.Add(m)
				}
			}
		}(s)
	}
	send := func(s *browseSock, qs []dns.Question) {
		for len(qs) > 0 {
			n := min(len(qs), 20)
			m := new(dns.Msg)
			m.Id = dns.Id()
			m.Question = qs[:n]
			qs = qs[n:]
			if b, err := m.Pack(); err == nil {
				_, _ = s.conn.WriteTo(b, mdns.GroupV4)
			}
		}
	}
	ptrQs := func(types []string) []dns.Question {
		var qs []dns.Question
		for _, t := range types {
			if f := fqdnService(t); f != "" {
				qs = append(qs, dns.Question{Name: f, Qtype: dns.TypePTR, Qclass: dns.ClassINET})
			}
		}
		return qs
	}
	wanted := map[string]bool{}
	for _, s := range a.Services {
		if n := mdns.NormalizeType(s); n != "" {
			wanted[n] = true
		}
	}
	sleepUntil := func(t time.Time) bool {
		select {
		case <-ctx.Done():
			return false
		case <-time.After(time.Until(t)):
			return true
		}
	}
	if len(wanted) == 0 {
		for _, s := range socks {
			send(s, []dns.Question{{Name: "_services._dns-sd._udp.local.", Qtype: dns.TypePTR, Qclass: dns.ClassINET}})
		}
		sleepUntil(start.Add(dur / 3))
		for _, s := range socks {
			send(s, ptrQs(s.recs.Types()))
		}
	} else {
		var types []string
		for t := range wanted {
			types = append(types, t)
		}
		sort.Strings(types)
		for _, s := range socks {
			send(s, ptrQs(types))
		}
		sleepUntil(start.Add(dur / 3))
		for _, s := range socks {
			send(s, ptrQs(types)) // retransmit once
		}
	}
	// Follow up on instances lacking SRV/TXT and hosts lacking addresses.
	if sleepUntil(start.Add(dur * 3 / 5)) {
		for _, s := range socks {
			insts, hosts := s.recs.Missing()
			var qs []dns.Question
			for _, in := range insts {
				qs = append(qs, dns.Question{Name: in, Qtype: dns.TypeSRV, Qclass: dns.ClassINET}, dns.Question{Name: in, Qtype: dns.TypeTXT, Qclass: dns.ClassINET})
			}
			for _, h := range hosts {
				qs = append(qs, dns.Question{Name: h, Qtype: dns.TypeA, Qclass: dns.ClassINET})
			}
			send(s, qs)
		}
	}
	wg.Wait()
	entries := []BrowseEntry{}
	for _, s := range socks {
		entries = append(entries, s.recs.Entries(s.iface, wanted)...)
	}
	data, _ := ops.FitFrame(len(entries), func(limit int) any {
		return map[string]any{"entries": entries[:min(limit, len(entries))]}
	})
	return data, nil
}

// SSDPEntry is one net.ssdp_search result.
type SSDPEntry struct {
	IP       string `json:"ip"`
	Location string `json:"location"`
	Server   string `json:"server"`
	ST       string `json:"st"`
	USN      string `json:"usn"`
	Iface    string `json:"iface"`
}

// SSDPSearch implements net.ssdp_search.
func (d *Discovery) SSDPSearch(ctx context.Context, raw json.RawMessage) (any, error) {
	var a struct {
		ST         string `json:"st"`
		DurationMs int64  `json:"duration_ms"`
	}
	if err := ops.Decode(raw, &a); err != nil {
		return nil, err
	}
	if a.ST == "" {
		a.ST = "ssdp:all"
	}
	if strings.ContainsAny(a.ST, "\r\n") {
		return nil, ops.BadArgs("invalid st")
	}
	dur := durationArg(ctx, a.DurationMs)
	mx := int(dur/time.Second) - 1
	if mx < 1 {
		mx = 1
	}
	if mx > 5 {
		mx = 5
	}
	req := ssdp.SearchRequest(a.ST, mx)
	deadline := time.Now().Add(dur)
	socks := d.openSockets(ctx, 2)
	var mu sync.Mutex
	seen := map[string]bool{}
	entries := []SSDPEntry{}
	var wg sync.WaitGroup
	for _, s := range socks {
		_ = s.conn.SetReadDeadline(deadline)
		_, _ = s.conn.WriteTo(req, ssdp.GroupV4)
		wg.Add(1)
		go func(s *browseSock) {
			defer wg.Done()
			defer s.conn.Close()
			resent := false
			buf := make([]byte, 9000)
			for {
				if !resent && time.Until(deadline) < dur*2/3 {
					_, _ = s.conn.WriteTo(req, ssdp.GroupV4)
					resent = true
				}
				_ = s.conn.SetReadDeadline(minTime(deadline, time.Now().Add(300*time.Millisecond)))
				n, src, err := s.conn.ReadFromUDPAddrPort(buf)
				if err != nil {
					if ne, ok := err.(net.Error); ok && ne.Timeout() && time.Now().Before(deadline) {
						continue
					}
					return
				}
				if d.own.Contains(src.Addr()) {
					continue
				}
				m, ok := ssdp.Parse(buf[:n])
				if !ok || m.Kind != "RESPONSE" {
					continue
				}
				e := SSDPEntry{IP: src.Addr().Unmap().String(), Location: m.Headers["location"], Server: m.Headers["server"], ST: m.Headers["st"], USN: m.Headers["usn"], Iface: s.iface}
				key := e.IP + "|" + e.USN + "|" + e.ST
				mu.Lock()
				if !seen[key] {
					seen[key] = true
					entries = append(entries, e)
				}
				mu.Unlock()
			}
		}(s)
	}
	wg.Wait()
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IP != entries[j].IP {
			return entries[i].IP < entries[j].IP
		}
		return entries[i].USN < entries[j].USN
	})
	data, _ := ops.FitFrame(len(entries), func(limit int) any {
		return map[string]any{"entries": entries[:min(limit, len(entries))]}
	})
	return data, nil
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}
