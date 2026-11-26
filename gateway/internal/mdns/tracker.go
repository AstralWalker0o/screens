package mdns

import (
	"hash/fnv"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/miekg/dns"
)

// SRVHostWindow is how long an SRV target counts as "seen" for
// hostname-only packets (§5: last 10 min).
const SRVHostWindow = 10 * time.Minute

// Service is one tracked service instance (mdns.status / mdns.services).
type Service struct {
	Service  string   `json:"service"`
	Instance string   `json:"instance"`
	Host     string   `json:"host"`
	Addrs    []string `json:"addrs"`
	Port     int      `json:"port"`
	Iface    string   `json:"iface"`
	LastSeen int64    `json:"last_seen"`
}

type instEntry struct {
	service  string
	full     string
	host     string
	port     int
	iface    string
	lastSeen time.Time
	expires  time.Time
}

type hostEntry struct {
	addrs map[string]time.Time // addr → expiry
}

// Tracker records services seen in mDNS responses.
type Tracker struct {
	mu        sync.Mutex
	instances map[string]*instEntry
	hosts     map[string]*hostEntry           // iface|host → addrs
	srvHosts  map[string]map[string]time.Time // host → service type → last seen
}

// NewTracker creates an empty tracker.
func NewTracker() *Tracker {
	return &Tracker{instances: map[string]*instEntry{}, hosts: map[string]*hostEntry{}, srvHosts: map[string]map[string]time.Time{}}
}

func ttlLife(ttl uint32) time.Duration {
	d := time.Duration(ttl) * time.Second
	if d < 2*time.Minute {
		d = 2 * time.Minute
	}
	if d > 2*time.Hour {
		d = 2 * time.Hour
	}
	return d
}

// ObserveSRV records SRV targets from any packet (query known-answers
// included) for the hostname-only rule.
func (t *Tracker) ObserveSRV(m *dns.Msg, now time.Time) {
	for _, sec := range [][]dns.RR{m.Answer, m.Ns, m.Extra} {
		for _, rr := range sec {
			srv, ok := rr.(*dns.SRV)
			if !ok || srv.Hdr.Ttl == 0 {
				continue
			}
			st := ServiceType(srv.Hdr.Name)
			if st == "" {
				continue
			}
			host := strings.ToLower(srv.Target)
			t.mu.Lock()
			m := t.srvHosts[host]
			if m == nil {
				m = map[string]time.Time{}
				t.srvHosts[host] = m
			}
			m[st] = now
			t.mu.Unlock()
		}
	}
}

// HostSeen implements HostSeenFunc.
func (t *Tracker) HostSeen(now time.Time) HostSeenFunc {
	return func(host string, r Rule) bool {
		t.mu.Lock()
		defer t.mu.Unlock()
		for st, seen := range t.srvHosts[strings.ToLower(host)] {
			if now.Sub(seen) < SRVHostWindow && r.Allows(st) {
				return true
			}
		}
		return false
	}
}

// Observe records the services announced in a response received on iface.
func (t *Tracker) Observe(iface string, m *dns.Msg, now time.Time) {
	if !m.Response {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, sec := range [][]dns.RR{m.Answer, m.Ns, m.Extra} {
		for _, rr := range sec {
			h := rr.Header()
			switch v := rr.(type) {
			case *dns.PTR:
				st := ServiceType(h.Name)
				if st == "" || st == "_dns-sd._udp" || ServiceType(v.Ptr) != st || strings.HasPrefix(strings.ToLower(v.Ptr), st+".") {
					continue
				}
				key := iface + "|" + strings.ToLower(v.Ptr)
				if h.Ttl == 0 {
					delete(t.instances, key)
					continue
				}
				e := t.instances[key]
				if e == nil {
					e = &instEntry{service: st, full: v.Ptr, iface: iface}
					t.instances[key] = e
				}
				e.lastSeen, e.expires = now, now.Add(ttlLife(h.Ttl))
			case *dns.SRV:
				st := ServiceType(h.Name)
				if st == "" {
					continue
				}
				key := iface + "|" + strings.ToLower(h.Name)
				if h.Ttl == 0 {
					delete(t.instances, key)
					continue
				}
				e := t.instances[key]
				if e == nil {
					e = &instEntry{service: st, full: h.Name, iface: iface}
					t.instances[key] = e
				}
				e.host, e.port = v.Target, int(v.Port)
				e.lastSeen = now
				if exp := now.Add(ttlLife(h.Ttl)); exp.After(e.expires) {
					e.expires = exp
				}
				host := strings.ToLower(v.Target)
				hm := t.srvHosts[host]
				if hm == nil {
					hm = map[string]time.Time{}
					t.srvHosts[host] = hm
				}
				hm[st] = now
			case *dns.A:
				t.addAddr(iface, h.Name, v.A.String(), h.Ttl, now)
			case *dns.AAAA:
				t.addAddr(iface, h.Name, v.AAAA.String(), h.Ttl, now)
			}
		}
	}
}

func (t *Tracker) addAddr(iface, host, addr string, ttl uint32, now time.Time) {
	key := iface + "|" + strings.ToLower(host)
	e := t.hosts[key]
	if e == nil {
		e = &hostEntry{addrs: map[string]time.Time{}}
		t.hosts[key] = e
	}
	if ttl == 0 {
		delete(e.addrs, addr)
		return
	}
	e.addrs[addr] = now.Add(ttlLife(ttl))
}

// Expire removes stale entries.
func (t *Tracker) Expire(now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for k, e := range t.instances {
		if now.After(e.expires) {
			delete(t.instances, k)
		}
	}
	for k, e := range t.hosts {
		for a, exp := range e.addrs {
			if now.After(exp) {
				delete(e.addrs, a)
			}
		}
		if len(e.addrs) == 0 {
			delete(t.hosts, k)
		}
	}
	for h, m := range t.srvHosts {
		for st, seen := range m {
			if now.Sub(seen) >= SRVHostWindow {
				delete(m, st)
			}
		}
		if len(m) == 0 {
			delete(t.srvHosts, h)
		}
	}
}

// List returns the tracked services, sorted.
func (t *Tracker) List(now time.Time) []Service {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := []Service{}
	for _, e := range t.instances {
		if now.After(e.expires) {
			continue
		}
		s := Service{
			Service:  e.service,
			Instance: InstanceLabel(e.full, e.service),
			Host:     Unescape(TrimDot(e.host)),
			Addrs:    []string{},
			Port:     e.port,
			Iface:    e.iface,
			LastSeen: e.lastSeen.UnixMilli(),
		}
		if he := t.hosts[e.iface+"|"+strings.ToLower(e.host)]; he != nil {
			for a, exp := range he.addrs {
				if now.Before(exp) {
					s.Addrs = append(s.Addrs, a)
				}
			}
			sort.Strings(s.Addrs)
		}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Service != out[j].Service {
			return out[i].Service < out[j].Service
		}
		if out[i].Instance != out[j].Instance {
			return out[i].Instance < out[j].Instance
		}
		return out[i].Iface < out[j].Iface
	})
	return out
}

// Fingerprint hashes a service list ignoring last_seen, to detect changes.
func Fingerprint(list []Service) uint64 {
	h := fnv.New64a()
	for _, s := range list {
		h.Write([]byte(s.Service + "\x00" + s.Instance + "\x00" + s.Host + "\x00" + strings.Join(s.Addrs, ",") + "\x00" + s.Iface + "\x00"))
		var b [8]byte
		for i := 0; i < 8; i++ {
			b[i] = byte(s.Port >> (8 * i))
		}
		h.Write(b[:])
	}
	return h.Sum64()
}
