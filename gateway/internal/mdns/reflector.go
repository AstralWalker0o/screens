package mdns

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/miekg/dns"
	"golang.org/x/net/ipv4"
	"golang.org/x/net/ipv6"

	"github.com/astralwalker0o/screens/gateway/internal/netx"
	"github.com/astralwalker0o/screens/gateway/internal/ssdp"
)

// Multicast groups.
var (
	GroupV4 = &net.UDPAddr{IP: net.IPv4(224, 0, 0, 251), Port: 5353}
	GroupV6 = &net.UDPAddr{IP: net.ParseIP("ff02::fb"), Port: 5353}
)

// Config is the mdns.configure argument object.
type Config struct {
	Enabled       bool         `json:"enabled"`
	Interfaces    []string     `json:"interfaces"`
	Rules         []RuleConfig `json:"rules"`
	SSDP          ssdp.Config  `json:"ssdp"`
	RateLimitPPS  int          `json:"rate_limit_pps"`
	TrackServices bool         `json:"track_services"`
}

// RuleConfig is one reflection rule as sent by the hub.
type RuleConfig struct {
	From  string   `json:"from"`
	To    []string `json:"to"`
	Allow []string `json:"allow"`
	Deny  []string `json:"deny"`
}

// ParseConfig decodes mdns.configure args with defaults
// (rate_limit_pps 200, track_services true).
func ParseConfig(raw json.RawMessage) (Config, error) {
	cfg := Config{RateLimitPPS: 200, TrackServices: true}
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &cfg); err != nil {
			return cfg, fmt.Errorf("mdns config: %w", err)
		}
	}
	for i, r := range cfg.Rules {
		if r.From == "" {
			return cfg, fmt.Errorf("rule %d: from is required", i)
		}
	}
	return cfg, nil
}

type ifSock struct {
	name    string
	index   int
	c4      *net.UDPConn
	p4      *ipv4.PacketConn
	c6      *net.UDPConn
	p6      *ipv6.PacketConn
	rx, tx  atomic.Uint64
	dropped atomic.Uint64
}

func (s *ifSock) close() {
	if s.c4 != nil {
		s.c4.Close()
	}
	if s.c6 != nil {
		s.c6.Close()
	}
}

type compiled struct {
	cfg   Config
	rules map[string][]Rule
}

// Reflector reflects mDNS between interfaces.
type Reflector struct {
	log     *slog.Logger
	own     *netx.OwnAddrs
	limiter *netx.RateLimiter
	dedup   *netx.Dedup
	tracker *Tracker
	ssdp    *ssdp.Relay

	cur      atomic.Pointer[compiled]
	mu       sync.Mutex
	socks    map[string]*ifSock
	openErrs map[string]string
	applyMu  sync.Mutex

	reflected   atomic.Uint64
	filtered    atomic.Uint64
	rateLimited atomic.Uint64

	stop chan struct{}
	wg   sync.WaitGroup
}

// New creates a reflector. Nothing listens until Apply.
func New(log *slog.Logger, own *netx.OwnAddrs) *Reflector {
	limiter := netx.NewRateLimiter(200)
	r := &Reflector{
		log:      log,
		own:      own,
		limiter:  limiter,
		dedup:    netx.NewDedup(time.Second),
		tracker:  NewTracker(),
		ssdp:     ssdp.NewRelay(log, own, limiter),
		socks:    map[string]*ifSock{},
		openErrs: map[string]string{},
		stop:     make(chan struct{}),
	}
	r.cur.Store(&compiled{rules: map[string][]Rule{}})
	r.wg.Add(1)
	go r.maintain()
	return r
}

// Tracker exposes the service tracker.
func (r *Reflector) Tracker() *Tracker { return r.tracker }

// Result is the mdns.configure result.
type Result struct {
	Enabled    bool     `json:"enabled"`
	Interfaces []string `json:"interfaces"`
	Errors     []string `json:"errors,omitempty"`
}

// Apply installs a configuration, opening/closing sockets as needed.
func (r *Reflector) Apply(cfg Config) Result {
	r.applyMu.Lock()
	defer r.applyMu.Unlock()
	c := &compiled{cfg: cfg, rules: map[string][]Rule{}}
	want := map[string]bool{}
	if cfg.Enabled {
		for _, n := range cfg.Interfaces {
			want[n] = true
		}
		for _, rc := range cfg.Rules {
			c.rules[rc.From] = append(c.rules[rc.From], CompileRule(rc.From, rc.To, rc.Allow, rc.Deny))
			want[rc.From] = true
			for _, t := range rc.To {
				want[t] = true
			}
		}
	}
	r.limiter.SetRate(cfg.RateLimitPPS)
	r.cur.Store(c)
	errs := r.sync(want)
	errs = append(errs, r.ssdp.Apply(cfg.SSDP, cfg.Enabled)...)
	res := Result{Enabled: cfg.Enabled, Interfaces: []string{}, Errors: errs}
	r.mu.Lock()
	for n := range r.socks {
		res.Interfaces = append(res.Interfaces, n)
	}
	r.mu.Unlock()
	sort.Strings(res.Interfaces)
	return res
}

func (r *Reflector) sync(want map[string]bool) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	for n, s := range r.socks {
		if !want[n] {
			s.close()
			delete(r.socks, n)
		}
	}
	var errs []string
	for n := range want {
		if _, ok := r.socks[n]; ok {
			continue
		}
		s, err := r.open(n)
		if err != nil {
			msg := err.Error()
			if r.openErrs[n] != msg {
				r.log.Warn("mdns interface unavailable", "iface", n, "err", err)
				r.openErrs[n] = msg
			}
			errs = append(errs, "mdns "+n+": "+msg)
			continue
		}
		delete(r.openErrs, n)
		r.socks[n] = s
		r.log.Info("mdns listening", "iface", n, "ipv4", s.p4 != nil, "ipv6", s.p6 != nil)
		if s.p4 != nil {
			r.wg.Add(1)
			go r.read4(s)
		}
		if s.p6 != nil {
			r.wg.Add(1)
			go r.read6(s)
		}
	}
	return errs
}

func (r *Reflector) open(name string) (*ifSock, error) {
	ifi, err := net.InterfaceByName(name)
	if err != nil {
		return nil, err
	}
	if ifi.Flags&net.FlagUp == 0 {
		return nil, fmt.Errorf("interface is down")
	}
	s := &ifSock{name: name, index: ifi.Index}
	var err4, err6 error
	if c, err := netx.ListenUDP(context.Background(), "udp4", "0.0.0.0:5353", name, true); err == nil {
		p := ipv4.NewPacketConn(c)
		if err := p.JoinGroup(ifi, &net.UDPAddr{IP: GroupV4.IP}); err != nil {
			c.Close()
			err4 = err
		} else {
			_ = p.SetMulticastInterface(ifi)
			_ = p.SetMulticastTTL(255)
			_ = p.SetMulticastLoopback(false)
			_ = p.SetControlMessage(ipv4.FlagDst|ipv4.FlagInterface, true)
			s.c4, s.p4 = c, p
		}
	} else {
		err4 = err
	}
	if c, err := netx.ListenUDP(context.Background(), "udp6", "[::]:5353", name, true); err == nil {
		p := ipv6.NewPacketConn(c)
		if err := p.JoinGroup(ifi, &net.UDPAddr{IP: GroupV6.IP}); err != nil {
			c.Close()
			err6 = err
		} else {
			_ = p.SetMulticastInterface(ifi)
			_ = p.SetMulticastHopLimit(255)
			_ = p.SetMulticastLoopback(false)
			_ = p.SetControlMessage(ipv6.FlagDst|ipv6.FlagInterface, true)
			s.c6, s.p6 = c, p
		}
	} else {
		err6 = err
	}
	if s.p4 == nil && s.p6 == nil {
		return nil, fmt.Errorf("ipv4: %v; ipv6: %v", err4, err6)
	}
	return s, nil
}

func (r *Reflector) read4(s *ifSock) {
	defer r.wg.Done()
	buf := make([]byte, 9000)
	for {
		n, cm, src, err := s.p4.ReadFrom(buf)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				continue
			}
			return
		}
		if cm != nil {
			if cm.IfIndex != 0 && cm.IfIndex != s.index {
				continue
			}
			if cm.Dst != nil && !cm.Dst.IsMulticast() {
				continue
			}
		}
		if ua, ok := src.(*net.UDPAddr); ok {
			a, _ := netip.AddrFromSlice(ua.IP)
			r.handle(s, append([]byte(nil), buf[:n]...), a.Unmap(), false)
		}
	}
}

func (r *Reflector) read6(s *ifSock) {
	defer r.wg.Done()
	buf := make([]byte, 9000)
	for {
		n, cm, src, err := s.p6.ReadFrom(buf)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				continue
			}
			return
		}
		if cm != nil {
			if cm.IfIndex != 0 && cm.IfIndex != s.index {
				continue
			}
			if cm.Dst != nil && !cm.Dst.IsMulticast() {
				continue
			}
		}
		if ua, ok := src.(*net.UDPAddr); ok {
			a, _ := netip.AddrFromSlice(ua.IP)
			r.handle(s, append([]byte(nil), buf[:n]...), a, true)
		}
	}
}

func (r *Reflector) sock(name string) *ifSock {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.socks[name]
}

// Decision is the outcome of processing one packet (exposed for tests).
type Decision struct {
	Drop    string   // "own", "rate", "parse", "nomatch", "dup" or ""
	To      []string // interfaces to send to
	Payload []byte
	// PerTarget overrides Payload for interfaces whose rule stripped denied
	// records from the packet.
	PerTarget map[string][]byte
}

// PayloadFor returns the bytes to send to one target interface.
func (d Decision) PayloadFor(iface string) []byte {
	if p, ok := d.PerTarget[iface]; ok {
		return p
	}
	return d.Payload
}

// Decide runs the reflection pipeline for a packet received on iface from
// src, without touching sockets.
func (r *Reflector) Decide(iface string, pkt []byte, src netip.Addr, now time.Time) Decision {
	if r.own.Contains(src) {
		return Decision{Drop: "own"}
	}
	if !r.limiter.Allow("mdns|"+iface, now) {
		return Decision{Drop: "rate"}
	}
	m := new(dns.Msg)
	if err := m.Unpack(pkt); err != nil {
		return Decision{Drop: "parse"}
	}
	// A packet we reflected less than 1 s ago coming back (via another
	// reflector) is a loop: drop it before it pollutes the tracker.
	h := netx.Hash(pkt)
	if r.dedup.Seen(h, now) {
		return Decision{Drop: "dup"}
	}
	c := r.cur.Load()
	r.tracker.ObserveSRV(m, now)
	if c.cfg.TrackServices {
		r.tracker.Observe(iface, m, now)
	}
	rules := c.rules[iface]
	if len(rules) == 0 {
		return Decision{Drop: "nomatch"}
	}
	seen := r.tracker.HostSeen(now)
	var to []string
	var per map[string][]byte
	dupe := map[string]bool{iface: true}
	for _, rule := range rules {
		mm, stripped := StripDenied(m, rule)
		if stripped && len(mm.Question) == 0 && len(mm.Answer) == 0 && len(mm.Ns) == 0 {
			continue
		}
		if !Match(mm, rule, seen) {
			continue
		}
		var payload []byte
		if stripped {
			mm.Compress = true
			b, err := mm.Pack()
			if err != nil {
				continue
			}
			payload, _ = PrepareForReflection(mm, b)
		}
		for _, t := range rule.To {
			if !dupe[t] {
				dupe[t] = true
				to = append(to, t)
				if stripped {
					if per == nil {
						per = map[string][]byte{}
					}
					per[t] = payload
				}
			}
		}
	}
	if len(to) == 0 {
		return Decision{Drop: "nomatch"}
	}
	out, changed := PrepareForReflection(m, pkt)
	r.dedup.Add(h, now)
	if changed {
		r.dedup.Add(netx.Hash(out), now)
	}
	for _, p := range per {
		r.dedup.Add(netx.Hash(p), now)
	}
	return Decision{To: to, Payload: out, PerTarget: per}
}

func (r *Reflector) handle(s *ifSock, pkt []byte, src netip.Addr, v6 bool) {
	s.rx.Add(1)
	d := r.Decide(s.name, pkt, src, time.Now())
	switch d.Drop {
	case "own":
		return
	case "rate":
		s.dropped.Add(1)
		r.rateLimited.Add(1)
		return
	case "":
	default:
		r.filtered.Add(1)
		return
	}
	sent := false
	for _, to := range d.To {
		t := r.sock(to)
		if t == nil {
			continue
		}
		var err error
		if v6 {
			if t.p6 == nil {
				continue
			}
			_, err = t.p6.WriteTo(d.PayloadFor(to), &ipv6.ControlMessage{IfIndex: t.index}, GroupV6)
		} else {
			if t.p4 == nil {
				continue
			}
			_, err = t.p4.WriteTo(d.PayloadFor(to), &ipv4.ControlMessage{IfIndex: t.index}, GroupV4)
		}
		if err != nil {
			r.log.Debug("mdns send failed", "iface", to, "err", err)
			continue
		}
		t.tx.Add(1)
		sent = true
	}
	if sent {
		r.reflected.Add(1)
	} else {
		r.filtered.Add(1)
	}
}

func (r *Reflector) maintain() {
	defer r.wg.Done()
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-r.stop:
			return
		case <-t.C:
		}
		r.tracker.Expire(time.Now())
		// Retry interfaces that failed to open (e.g. VLAN came up late).
		r.applyMu.Lock()
		c := r.cur.Load()
		if c.cfg.Enabled {
			r.mu.Lock()
			missing := len(r.openErrs) > 0
			r.mu.Unlock()
			if missing {
				want := map[string]bool{}
				for _, n := range c.cfg.Interfaces {
					want[n] = true
				}
				for _, rc := range c.cfg.Rules {
					want[rc.From] = true
					for _, to := range rc.To {
						want[to] = true
					}
				}
				r.sync(want)
				r.ssdp.Apply(c.cfg.SSDP, true)
			}
		}
		r.applyMu.Unlock()
	}
}

// Close stops everything.
func (r *Reflector) Close() {
	close(r.stop)
	r.applyMu.Lock()
	r.cur.Store(&compiled{rules: map[string][]Rule{}})
	r.sync(map[string]bool{})
	r.applyMu.Unlock()
	r.ssdp.Close()
	r.wg.Wait()
}

// IfStatus is per-interface status.
type IfStatus struct {
	Name    string `json:"name"`
	Rx      uint64 `json:"rx"`
	Tx      uint64 `json:"tx"`
	Dropped uint64 `json:"dropped"`
}

// Counters are reflector totals.
type Counters struct {
	Reflected   uint64 `json:"reflected"`
	Filtered    uint64 `json:"filtered"`
	RateLimited uint64 `json:"rate_limited"`
	SSDPRelayed uint64 `json:"ssdp_relayed"`
}

// Status is the mdns.status result.
type Status struct {
	Enabled    bool       `json:"enabled"`
	Interfaces []IfStatus `json:"interfaces"`
	Services   []Service  `json:"services"`
	Counters   Counters   `json:"counters"`
}

// Counters returns totals.
func (r *Reflector) Counters() Counters {
	return Counters{Reflected: r.reflected.Load(), Filtered: r.filtered.Load(), RateLimited: r.rateLimited.Load(), SSDPRelayed: r.ssdp.Relayed()}
}

// Services lists tracked services.
func (r *Reflector) Services() []Service { return r.tracker.List(time.Now()) }

// Status returns mdns.status.
func (r *Reflector) Status() Status {
	c := r.cur.Load()
	st := Status{Enabled: c.cfg.Enabled, Interfaces: []IfStatus{}, Services: r.Services(), Counters: r.Counters()}
	sc := r.ssdp.Counters()
	r.mu.Lock()
	names := map[string]bool{}
	for n := range r.socks {
		names[n] = true
	}
	for n := range sc {
		names[n] = true
	}
	for n := range names {
		is := IfStatus{Name: n}
		if s := r.socks[n]; s != nil {
			is.Rx, is.Tx, is.Dropped = s.rx.Load(), s.tx.Load(), s.dropped.Load()
		}
		if c, ok := sc[n]; ok {
			is.Rx += c.Rx
			is.Tx += c.Tx
			is.Dropped += c.Dropped
		}
		st.Interfaces = append(st.Interfaces, is)
	}
	r.mu.Unlock()
	sort.Slice(st.Interfaces, func(i, j int) bool { return st.Interfaces[i].Name < st.Interfaces[j].Name })
	return st
}
