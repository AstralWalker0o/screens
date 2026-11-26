// Package ssdp relays SSDP between interfaces (PROTOCOL.md §5 mDNS / SSDP
// reflector): M-SEARCH is re-sent on each target interface from an
// ephemeral socket, unicast responses are relayed back to the requester,
// and multicast NOTIFY is reflected by the same rules.
package ssdp

import (
	"bufio"
	"bytes"
	"context"
	"log/slog"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/net/ipv4"

	"github.com/astralwalker0o/screens/gateway/internal/netx"
)

// GroupV4 is the SSDP multicast group.
var GroupV4 = &net.UDPAddr{IP: net.IPv4(239, 255, 255, 250), Port: 1900}

// Config is mdns.configure's "ssdp" object.
type Config struct {
	Enabled bool   `json:"enabled"`
	Rules   []Rule `json:"rules"`
}

// Rule reflects SSDP from one interface to others.
type Rule struct {
	From string   `json:"from"`
	To   []string `json:"to"`
}

// Message is a parsed SSDP datagram.
type Message struct {
	Kind    string            // "M-SEARCH", "NOTIFY" or "RESPONSE"
	Headers map[string]string // lower-case keys
}

// Parse parses an SSDP datagram's start line and headers.
func Parse(b []byte) (Message, bool) {
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 0, 4096), 64<<10)
	if !sc.Scan() {
		return Message{}, false
	}
	start := strings.TrimSpace(sc.Text())
	var m Message
	switch {
	case strings.HasPrefix(strings.ToUpper(start), "M-SEARCH "):
		m.Kind = "M-SEARCH"
	case strings.HasPrefix(strings.ToUpper(start), "NOTIFY "):
		m.Kind = "NOTIFY"
	case strings.HasPrefix(strings.ToUpper(start), "HTTP/1."):
		m.Kind = "RESPONSE"
	default:
		return Message{}, false
	}
	m.Headers = map[string]string{}
	for sc.Scan() {
		line := sc.Text()
		if strings.TrimSpace(line) == "" {
			break
		}
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		m.Headers[strings.ToLower(strings.TrimSpace(k))] = strings.TrimSpace(v)
	}
	return m, true
}

// Wait is how long to collect responses to an M-SEARCH: MX+1 s, at most
// 5 s (MX defaults to 1).
func (m Message) Wait() time.Duration {
	mx := 1
	if v, ok := m.Headers["mx"]; ok {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n >= 0 {
			mx = n
		}
	}
	w := time.Duration(mx+1) * time.Second
	if w > 5*time.Second {
		w = 5 * time.Second
	}
	return w
}

// IfCounters are per-interface packet counters.
type IfCounters struct {
	Rx, Tx, Dropped uint64
}

type sock struct {
	name    string
	index   int
	conn    *net.UDPConn
	pc      *ipv4.PacketConn
	rx, tx  atomic.Uint64
	dropped atomic.Uint64
}

type compiled struct {
	enabled bool
	rules   map[string][]Rule
}

// Relay is the SSDP relay.
type Relay struct {
	log     *slog.Logger
	own     *netx.OwnAddrs
	limiter *netx.RateLimiter
	dedup   *netx.Dedup

	cur     atomic.Pointer[compiled]
	mu      sync.Mutex
	socks   map[string]*sock
	relayed atomic.Uint64
	sem     chan struct{}
	wg      sync.WaitGroup
	closed  atomic.Bool
}

// NewRelay creates a relay (nothing listens until Apply).
func NewRelay(log *slog.Logger, own *netx.OwnAddrs, limiter *netx.RateLimiter) *Relay {
	r := &Relay{log: log, own: own, limiter: limiter, dedup: netx.NewDedup(time.Second), socks: map[string]*sock{}, sem: make(chan struct{}, 32)}
	r.cur.Store(&compiled{})
	return r
}

// Relayed counts relayed packets (M-SEARCH out, responses back, NOTIFY).
func (r *Relay) Relayed() uint64 { return r.relayed.Load() }

// Counters returns per-interface counters.
func (r *Relay) Counters() map[string]IfCounters {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := map[string]IfCounters{}
	for n, s := range r.socks {
		out[n] = IfCounters{Rx: s.rx.Load(), Tx: s.tx.Load(), Dropped: s.dropped.Load()}
	}
	return out
}

// Apply installs rules and opens/closes sockets. It returns errors for
// interfaces that could not be opened (retried on the next Apply).
func (r *Relay) Apply(cfg Config, enabled bool) []string {
	c := &compiled{enabled: enabled && cfg.Enabled, rules: map[string][]Rule{}}
	want := map[string]bool{}
	if c.enabled {
		for _, rule := range cfg.Rules {
			if rule.From == "" || len(rule.To) == 0 {
				continue
			}
			c.rules[rule.From] = append(c.rules[rule.From], rule)
			want[rule.From] = true
			for _, t := range rule.To {
				want[t] = true
			}
		}
	}
	r.cur.Store(c)
	var errs []string
	r.mu.Lock()
	for name, s := range r.socks {
		if !want[name] {
			s.conn.Close()
			delete(r.socks, name)
		}
	}
	for name := range want {
		if _, ok := r.socks[name]; ok {
			continue
		}
		s, err := r.open(name)
		if err != nil {
			errs = append(errs, "ssdp "+name+": "+err.Error())
			continue
		}
		r.socks[name] = s
		r.wg.Add(1)
		go r.readLoop(s)
	}
	r.mu.Unlock()
	return errs
}

func (r *Relay) open(name string) (*sock, error) {
	ifi, err := net.InterfaceByName(name)
	if err != nil {
		return nil, err
	}
	c, err := netx.ListenUDP(context.Background(), "udp4", "0.0.0.0:1900", name, true)
	if err != nil {
		return nil, err
	}
	pc := ipv4.NewPacketConn(c)
	if err := pc.JoinGroup(ifi, &net.UDPAddr{IP: GroupV4.IP}); err != nil {
		c.Close()
		return nil, err
	}
	_ = pc.SetMulticastInterface(ifi)
	_ = pc.SetMulticastTTL(2)
	_ = pc.SetMulticastLoopback(false)
	_ = pc.SetControlMessage(ipv4.FlagDst|ipv4.FlagInterface, true)
	return &sock{name: name, index: ifi.Index, conn: c, pc: pc}, nil
}

// Close stops the relay.
func (r *Relay) Close() {
	r.closed.Store(true)
	r.Apply(Config{}, false)
	r.wg.Wait()
}

func (r *Relay) readLoop(s *sock) {
	defer r.wg.Done()
	buf := make([]byte, 9000)
	for {
		n, cm, src, err := s.pc.ReadFrom(buf)
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
		ua, ok := src.(*net.UDPAddr)
		if !ok {
			continue
		}
		ap := ua.AddrPort()
		pkt := append([]byte(nil), buf[:n]...)
		r.handle(s, pkt, netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port()))
	}
}

func (r *Relay) sockFor(name string) *sock {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.socks[name]
}

func (r *Relay) handle(s *sock, pkt []byte, src netip.AddrPort) {
	s.rx.Add(1)
	if r.own.Contains(src.Addr()) {
		return
	}
	now := time.Now()
	if !r.limiter.Allow("ssdp|"+s.name, now) {
		s.dropped.Add(1)
		return
	}
	c := r.cur.Load()
	rules := c.rules[s.name]
	if len(rules) == 0 {
		return
	}
	m, ok := Parse(pkt)
	if !ok || m.Kind == "RESPONSE" {
		return
	}
	h := netx.Hash(pkt)
	if r.dedup.Seen(h, now) {
		return
	}
	r.dedup.Add(h, now)
	switch m.Kind {
	case "NOTIFY":
		for _, rule := range rules {
			for _, to := range rule.To {
				t := r.sockFor(to)
				if t == nil || to == s.name {
					continue
				}
				if _, err := t.pc.WriteTo(pkt, &ipv4.ControlMessage{IfIndex: t.index}, GroupV4); err == nil {
					t.tx.Add(1)
					r.relayed.Add(1)
				}
			}
		}
	case "M-SEARCH":
		var targets []string
		for _, rule := range rules {
			for _, to := range rule.To {
				if to != s.name {
					targets = append(targets, to)
				}
			}
		}
		select {
		case r.sem <- struct{}{}:
		default:
			s.dropped.Add(1)
			return
		}
		r.wg.Add(1)
		go func() {
			defer r.wg.Done()
			defer func() { <-r.sem }()
			r.search(s.name, pkt, src, targets, m.Wait())
		}()
	}
}

// search re-sends an M-SEARCH on each target interface and relays the
// unicast responses back to the requester from the gateway's address on
// the requester's interface.
func (r *Relay) search(from string, pkt []byte, client netip.AddrPort, targets []string, wait time.Duration) {
	fi, ok := netx.ByName(from)
	if !ok {
		return
	}
	fromAddr, ok := fi.IPv4For(client.Addr())
	if !ok {
		return
	}
	reply, err := netx.ListenUDP(context.Background(), "udp4", netip.AddrPortFrom(fromAddr, 0).String(), from, false)
	if err != nil {
		r.log.Debug("ssdp reply socket", "iface", from, "err", err)
		return
	}
	defer reply.Close()
	fs := r.sockFor(from)
	deadline := time.Now().Add(wait)
	var wg sync.WaitGroup
	for _, to := range targets {
		ti, ok := netx.ByName(to)
		if !ok {
			continue
		}
		toAddr, ok := ti.FirstIPv4()
		if !ok {
			continue
		}
		eph, err := netx.ListenUDP(context.Background(), "udp4", netip.AddrPortFrom(toAddr, 0).String(), to, false)
		if err != nil {
			continue
		}
		pc := ipv4.NewPacketConn(eph)
		ifi, _ := net.InterfaceByIndex(ti.Index)
		if ifi != nil {
			_ = pc.SetMulticastInterface(ifi)
		}
		_ = pc.SetMulticastTTL(2)
		_ = pc.SetMulticastLoopback(false)
		if _, err := eph.WriteTo(pkt, GroupV4); err != nil {
			eph.Close()
			continue
		}
		if t := r.sockFor(to); t != nil {
			t.tx.Add(1)
		}
		r.relayed.Add(1)
		wg.Add(1)
		go func(eph *net.UDPConn) {
			defer wg.Done()
			defer eph.Close()
			_ = eph.SetReadDeadline(deadline)
			buf := make([]byte, 9000)
			for {
				n, src, err := eph.ReadFromUDPAddrPort(buf)
				if err != nil {
					return
				}
				if r.own.Contains(src.Addr()) {
					continue
				}
				if m, ok := Parse(buf[:n]); !ok || m.Kind != "RESPONSE" {
					continue
				}
				if _, err := reply.WriteToUDPAddrPort(buf[:n], client); err == nil {
					r.relayed.Add(1)
					if fs != nil {
						fs.tx.Add(1)
					}
				}
			}
		}(eph)
	}
	wg.Wait()
}

// SearchRequest builds an M-SEARCH datagram.
func SearchRequest(st string, mx int) []byte {
	if st == "" {
		st = "ssdp:all"
	}
	return []byte("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: " + strconv.Itoa(mx) + "\r\nST: " + st + "\r\nUSER-AGENT: Linux/1 UPnP/1.1 screens-gateway/1\r\n\r\n")
}
