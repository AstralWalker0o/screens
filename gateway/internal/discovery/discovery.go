// Package discovery implements the net.* operations (PROTOCOL.md §5
// Network / discovery). Every target passes the guard (§4).
package discovery

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/netip"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/astralwalker0o/screens/gateway/internal/guard"
	"github.com/astralwalker0o/screens/gateway/internal/netx"
	"github.com/astralwalker0o/screens/gateway/internal/ops"
	"github.com/astralwalker0o/screens/gateway/internal/proto"
)

// MaxScanHosts bounds one net.scan request.
const MaxScanHosts = 16384

// Discovery holds discovery state (none today beyond the own-address set).
type Discovery struct {
	own *netx.OwnAddrs
	// Interfaces overrides interface enumeration (tests).
	Interfaces func() []netx.Iface
}

// New creates the discovery ops.
func New(own *netx.OwnAddrs) *Discovery {
	return &Discovery{own: own, Interfaces: netx.Usable}
}

// Register adds the net.* ops.
func (d *Discovery) Register(r *ops.Registry) {
	r.Register("net.neighbors", d.Neighbors)
	r.Register("net.scan", d.Scan)
	r.Register("net.probe", d.Probe)
	r.Register("net.mdns_browse", d.MDNSBrowse)
	r.Register("net.ssdp_search", d.SSDPSearch)
	r.Register("net.wol", d.WOL)
}

// Neighbors implements net.neighbors.
func (d *Discovery) Neighbors(ctx context.Context, _ json.RawMessage) (any, error) {
	return map[string]any{"entries": netx.Neighbors(ctx)}, nil
}

type scanArgs struct {
	CIDRs       []string `json:"cidrs"`
	Ports       []int    `json:"ports"`
	TimeoutMs   int64    `json:"timeout_ms"`
	Concurrency int      `json:"concurrency"`
}

// ScanHost is one net.scan result.
type ScanHost struct {
	IP        string `json:"ip"`
	MAC       string `json:"mac,omitempty"`
	OpenPorts []int  `json:"open_ports"`
}

// DefaultScanPorts is used when ports is omitted.
var DefaultScanPorts = []int{5555, 8001, 8002, 3000, 3001, 1400, 8008, 8009}

// hostsOf enumerates the usable host addresses of an IPv4 prefix.
func hostsOf(p netip.Prefix) []netip.Addr {
	p = p.Masked()
	var out []netip.Addr
	first := p.Addr()
	bits := p.Bits()
	n := 1 << (32 - bits)
	a := first
	for i := 0; i < n; i++ {
		skip := bits <= 30 && (i == 0 || i == n-1) // network / broadcast
		if !skip {
			out = append(out, a)
		}
		a = a.Next()
	}
	return out
}

// DefaultScanPrefixes returns every IPv4 interface subnet /22 or smaller.
func DefaultScanPrefixes(ifaces []netx.Iface) []netip.Prefix {
	seen := map[netip.Prefix]bool{}
	var out []netip.Prefix
	for _, i := range ifaces {
		for _, p := range i.IPv4() {
			if p.Bits() < 22 || p.Addr().IsLoopback() {
				continue
			}
			m := p.Masked()
			if guard.CheckPrefix(m) != nil || seen[m] {
				continue
			}
			seen[m] = true
			out = append(out, m)
		}
	}
	return out
}

// Scan implements net.scan (TCP connect probe).
func (d *Discovery) Scan(ctx context.Context, raw json.RawMessage) (any, error) {
	var a scanArgs
	if err := ops.Decode(raw, &a); err != nil {
		return nil, err
	}
	if len(a.Ports) == 0 {
		a.Ports = DefaultScanPorts
	}
	for _, p := range a.Ports {
		if p < 1 || p > 65535 {
			return nil, ops.BadArgs("invalid port %d", p)
		}
	}
	timeout := time.Duration(ops.MsOr(a.TimeoutMs, 400, 10000)) * time.Millisecond
	conc := a.Concurrency
	if conc <= 0 {
		conc = 128
	}
	if conc > 1024 {
		conc = 1024
	}
	var prefixes []netip.Prefix
	if len(a.CIDRs) == 0 {
		prefixes = DefaultScanPrefixes(d.Interfaces())
	} else {
		for _, c := range a.CIDRs {
			p, err := netip.ParsePrefix(strings.TrimSpace(c))
			if err != nil {
				if ad, err2 := netip.ParseAddr(strings.TrimSpace(c)); err2 == nil {
					p = netip.PrefixFrom(ad, ad.BitLen())
				} else {
					return nil, ops.BadArgs("invalid cidr %q", c)
				}
			}
			if !p.Addr().Is4() {
				return nil, ops.BadArgs("only IPv4 cidrs can be scanned: %q", c)
			}
			if err := guard.CheckPrefix(p); err != nil {
				return nil, err
			}
			prefixes = append(prefixes, p.Masked())
		}
	}
	var targets []netip.Addr
	seen := map[netip.Addr]bool{}
	for _, p := range prefixes {
		if 1<<(32-p.Bits()) > MaxScanHosts {
			return nil, ops.BadArgs("cidr %s is larger than %d hosts", p, MaxScanHosts)
		}
		for _, h := range hostsOf(p) {
			if !seen[h] && !d.own.Contains(h) && guard.IsAllowedAddr(h) {
				seen[h] = true
				targets = append(targets, h)
			}
		}
		if len(targets) > MaxScanHosts {
			return nil, ops.BadArgs("scan larger than %d hosts", MaxScanHosts)
		}
	}

	type job struct {
		ip   netip.Addr
		port int
	}
	jobs := make(chan job)
	var mu sync.Mutex
	open := map[netip.Addr][]int{}
	var wg sync.WaitGroup
	for i := 0; i < conc; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			dialer := net.Dialer{Timeout: timeout}
			for j := range jobs {
				cctx, cancel := context.WithTimeout(ctx, timeout)
				c, err := dialer.DialContext(cctx, "tcp", netip.AddrPortFrom(j.ip, uint16(j.port)).String())
				cancel()
				if err == nil {
					c.Close()
					mu.Lock()
					open[j.ip] = append(open[j.ip], j.port)
					mu.Unlock()
				}
			}
		}()
	}
feed:
	for _, ip := range targets {
		for _, p := range a.Ports {
			select {
			case <-ctx.Done():
				break feed
			case jobs <- job{ip, p}:
			}
		}
	}
	close(jobs)
	wg.Wait()
	if ctx.Err() != nil {
		return nil, proto.Errf(proto.CodeTimeout, "scan did not finish: %v", ctx.Err())
	}
	macs := netx.MACTable(ctx)
	hosts := []ScanHost{}
	for ip, ports := range open {
		sort.Ints(ports)
		hosts = append(hosts, ScanHost{IP: ip.String(), MAC: macs[ip.String()], OpenPorts: ports})
	}
	sort.Slice(hosts, func(i, j int) bool {
		return netip.MustParseAddr(hosts[i].IP).Less(netip.MustParseAddr(hosts[j].IP))
	})
	return map[string]any{"hosts": hosts}, nil
}

type probeTarget struct {
	ID        string `json:"id"`
	IP        string `json:"ip"`
	Port      int    `json:"port"`
	Kind      string `json:"kind"`
	Path      string `json:"path"`
	TimeoutMs int64  `json:"timeout_ms"`
}

// ProbeResult is one net.probe result.
type ProbeResult struct {
	ID     string  `json:"id"`
	OK     bool    `json:"ok"`
	Ms     int64   `json:"ms"`
	Status *int    `json:"status,omitempty"`
	Body   *string `json:"body,omitempty"`
	Error  string  `json:"error,omitempty"`
}

var probeClient = &http.Client{
	Transport: &http.Transport{
		Proxy:             nil,
		DialContext:       guard.Dialer{Timeout: 5 * time.Second}.DialContext,
		DisableKeepAlives: true,
	},
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// Probe implements net.probe.
func (d *Discovery) Probe(ctx context.Context, raw json.RawMessage) (any, error) {
	var a struct {
		Targets []probeTarget `json:"targets"`
	}
	if err := ops.Decode(raw, &a); err != nil {
		return nil, err
	}
	if len(a.Targets) > 1024 {
		return nil, ops.BadArgs("too many targets")
	}
	for _, t := range a.Targets {
		if t.Port < 1 || t.Port > 65535 {
			return nil, ops.BadArgs("target %q: invalid port", t.ID)
		}
		if t.Kind != "tcp" && t.Kind != "http" && t.Kind != "" {
			return nil, ops.BadArgs("target %q: kind must be tcp or http", t.ID)
		}
		if _, err := guard.Resolve(ctx, t.IP); err != nil {
			return nil, err
		}
	}
	results := make([]ProbeResult, len(a.Targets))
	sem := make(chan struct{}, 32)
	var wg sync.WaitGroup
	for i, t := range a.Targets {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, t probeTarget) {
			defer wg.Done()
			defer func() { <-sem }()
			results[i] = probeOne(ctx, t)
		}(i, t)
	}
	wg.Wait()
	return map[string]any{"results": results}, nil
}

func probeOne(ctx context.Context, t probeTarget) ProbeResult {
	timeout := time.Duration(ops.MsOr(t.TimeoutMs, 2000, 30000)) * time.Millisecond
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	r := ProbeResult{ID: t.ID}
	start := time.Now()
	hostPort := net.JoinHostPort(strings.Trim(t.IP, "[]"), strconv.Itoa(t.Port))
	if t.Kind == "http" {
		path := t.Path
		if path == "" || path[0] != '/' {
			path = "/" + path
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+hostPort+path, nil)
		if err != nil {
			r.Error = err.Error()
			return r
		}
		resp, err := probeClient.Do(req)
		r.Ms = time.Since(start).Milliseconds()
		if err != nil {
			r.Error = err.Error()
			return r
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
		body := strings.ToValidUTF8(string(b), "�")
		r.OK, r.Status, r.Body = true, &resp.StatusCode, &body
		return r
	}
	c, err := guard.Dialer{Timeout: timeout}.DialContext(ctx, "tcp", hostPort)
	r.Ms = time.Since(start).Milliseconds()
	if err != nil {
		r.Error = proto.AsError(err).Message
		return r
	}
	c.Close()
	r.OK = true
	return r
}

// MagicPacket builds a Wake-on-LAN payload.
func MagicPacket(mac net.HardwareAddr) []byte {
	p := make([]byte, 0, 102)
	for i := 0; i < 6; i++ {
		p = append(p, 0xff)
	}
	for i := 0; i < 16; i++ {
		p = append(p, mac...)
	}
	return p
}

// WOL implements net.wol.
func (d *Discovery) WOL(ctx context.Context, raw json.RawMessage) (any, error) {
	var a struct {
		MAC       string `json:"mac"`
		Broadcast string `json:"broadcast"`
		Port      int    `json:"port"`
	}
	if err := ops.Decode(raw, &a); err != nil {
		return nil, err
	}
	mac, err := net.ParseMAC(a.MAC)
	if err != nil || len(mac) != 6 {
		return nil, ops.BadArgs("invalid mac %q", a.MAC)
	}
	if a.Port == 0 {
		a.Port = 9
	}
	if a.Port < 1 || a.Port > 65535 {
		return nil, ops.BadArgs("invalid port")
	}
	pkt := MagicPacket(mac)
	sent := 0
	send := func(local, dst netip.Addr, ifname string) {
		laddr := ":0"
		if local.IsValid() {
			laddr = netip.AddrPortFrom(local, 0).String()
		}
		c, err := netx.ListenUDP(ctx, "udp4", laddr, ifname, false)
		if err != nil {
			return
		}
		defer c.Close()
		_ = netx.SetBroadcast(c)
		if _, err := c.WriteToUDPAddrPort(pkt, netip.AddrPortFrom(dst, uint16(a.Port))); err == nil {
			sent++
		}
	}
	if a.Broadcast != "" {
		b, err := netip.ParseAddr(a.Broadcast)
		if err != nil || !b.Is4() {
			return nil, ops.BadArgs("invalid broadcast %q", a.Broadcast)
		}
		if b != netip.AddrFrom4([4]byte{255, 255, 255, 255}) {
			if err := guard.CheckAddr(b); err != nil {
				return nil, err
			}
		}
		send(netip.Addr{}, b, "")
	} else {
		for _, i := range d.Interfaces() {
			if !i.Multicast && !i.Broadcast {
				continue
			}
			for _, p := range i.IPv4() {
				if bc, ok := netx.DirectedBroadcast(p); ok && guard.CheckPrefix(p.Masked()) == nil {
					send(p.Addr(), bc, i.Name)
				}
			}
		}
	}
	if sent == 0 {
		return nil, proto.Errf(proto.CodeFailed, "magic packet could not be sent on any interface")
	}
	return map[string]any{"sent": sent}, nil
}
