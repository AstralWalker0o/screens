// Package netx holds host network helpers: interface enumeration and
// filtering, listen-address expansion (PROTOCOL.md §5 DNS), the gateway's own
// address set (mDNS/SSDP loop prevention), the neighbour table and socket
// options for per-interface sockets.
package netx

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/astralwalker0o/screens/gateway/internal/proto"
)

var skipPrefixes = []string{"docker", "br-", "veth", "cni", "flannel", "tailscale"}

// Skipped reports whether an interface name is virtual/overlay and must not
// be used for wildcard listeners, scans or reflection defaults.
func Skipped(name string) bool {
	if name == "lo" || strings.HasPrefix(name, "lo:") {
		return true
	}
	for _, p := range skipPrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// Iface is a snapshot of one interface.
type Iface struct {
	Index     int
	Name      string
	MAC       string
	Up        bool
	Multicast bool
	Broadcast bool
	Loopback  bool
	Prefixes  []netip.Prefix // address/prefix-length, zones stripped
}

// IPv4 returns the IPv4 prefixes.
func (i Iface) IPv4() []netip.Prefix {
	var out []netip.Prefix
	for _, p := range i.Prefixes {
		if p.Addr().Is4() {
			out = append(out, p)
		}
	}
	return out
}

// FirstIPv4 returns the first IPv4 address.
func (i Iface) FirstIPv4() (netip.Addr, bool) {
	for _, p := range i.Prefixes {
		if p.Addr().Is4() {
			return p.Addr(), true
		}
	}
	return netip.Addr{}, false
}

// IPv4For returns the interface IPv4 address on the same subnet as peer,
// falling back to the first IPv4 address.
func (i Iface) IPv4For(peer netip.Addr) (netip.Addr, bool) {
	peer = peer.Unmap()
	for _, p := range i.Prefixes {
		if p.Addr().Is4() && p.Contains(peer) {
			return p.Addr(), true
		}
	}
	return i.FirstIPv4()
}

// List enumerates all interfaces (including skipped ones).
var List = func() ([]Iface, error) {
	ifs, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	out := make([]Iface, 0, len(ifs))
	for _, ifi := range ifs {
		it := Iface{
			Index:     ifi.Index,
			Name:      ifi.Name,
			MAC:       ifi.HardwareAddr.String(),
			Up:        ifi.Flags&net.FlagUp != 0,
			Multicast: ifi.Flags&net.FlagMulticast != 0,
			Broadcast: ifi.Flags&net.FlagBroadcast != 0,
			Loopback:  ifi.Flags&net.FlagLoopback != 0,
		}
		addrs, _ := ifi.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip, ok := netip.AddrFromSlice(ipn.IP)
			if !ok {
				continue
			}
			ones, _ := ipn.Mask.Size()
			ip = ip.Unmap()
			it.Prefixes = append(it.Prefixes, netip.PrefixFrom(ip, ones))
		}
		out = append(out, it)
	}
	return out, nil
}

// Usable returns up, non-loopback, non-skipped interfaces.
func Usable() []Iface {
	all, err := List()
	if err != nil {
		return nil
	}
	var out []Iface
	for _, i := range all {
		if i.Up && !i.Loopback && !Skipped(i.Name) {
			out = append(out, i)
		}
	}
	return out
}

// ByName finds an interface by name.
func ByName(name string) (Iface, bool) {
	all, err := List()
	if err != nil {
		return Iface{}, false
	}
	for _, i := range all {
		if i.Name == name {
			return i, true
		}
	}
	return Iface{}, false
}

// Describe returns the proto description of non-skipped interfaces.
func Describe() []proto.Interface {
	all, _ := List()
	out := []proto.Interface{}
	for _, i := range all {
		if i.Loopback || Skipped(i.Name) {
			continue
		}
		pi := proto.Interface{Name: i.Name, MAC: i.MAC, Up: i.Up, Multicast: i.Multicast, Addrs: []string{}}
		for _, p := range i.Prefixes {
			pi.Addrs = append(pi.Addrs, p.String())
		}
		out = append(out, pi)
	}
	return out
}

// ExpandListen expands DNS listen entries (§5 DNS `listen`) against ifaces.
// "0.0.0.0:<port>" (or ":<port>") becomes one entry per non-loopback IPv4
// address of non-skipped interfaces; "[::]:<port>" becomes one per global or
// ULA IPv6 address. Explicit entries pass through. Output is deduplicated and
// sorted. Invalid entries are returned in bad.
func ExpandListen(entries []string, ifaces []Iface) (out []string, bad []string) {
	seen := map[string]bool{}
	add := func(s string) {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	for _, e := range entries {
		host, port, err := net.SplitHostPort(strings.TrimSpace(e))
		if err != nil {
			bad = append(bad, e)
			continue
		}
		if p, err := strconv.Atoi(port); err != nil || p < 0 || p > 65535 {
			bad = append(bad, e)
			continue
		}
		switch host {
		case "", "0.0.0.0":
			for _, i := range ifaces {
				if !i.Up || i.Loopback || Skipped(i.Name) {
					continue
				}
				for _, p := range i.Prefixes {
					a := p.Addr()
					if a.Is4() && !a.IsLoopback() {
						add(net.JoinHostPort(a.String(), port))
					}
				}
			}
		case "::":
			for _, i := range ifaces {
				if !i.Up || i.Loopback || Skipped(i.Name) {
					continue
				}
				for _, p := range i.Prefixes {
					a := p.Addr()
					if a.Is6() && !a.Is4In6() && !a.IsLoopback() && !a.IsLinkLocalUnicast() && (a.IsGlobalUnicast() || a.IsPrivate()) {
						add(net.JoinHostPort(a.String(), port))
					}
				}
			}
		default:
			if _, err := netip.ParseAddr(host); err != nil {
				bad = append(bad, e)
				continue
			}
			add(net.JoinHostPort(host, port))
		}
	}
	sort.Strings(out)
	return out, bad
}

// OwnAddrs tracks every address configured on the host (all interfaces),
// refreshed at most every few seconds.
type OwnAddrs struct {
	mu      sync.Mutex
	set     map[netip.Addr]bool
	fetched time.Time
	ttl     time.Duration
}

// NewOwnAddrs creates a tracker.
func NewOwnAddrs() *OwnAddrs { return &OwnAddrs{ttl: 5 * time.Second} }

// Contains reports whether a belongs to the gateway host.
func (o *OwnAddrs) Contains(a netip.Addr) bool {
	a = a.Unmap().WithZone("")
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.set == nil || time.Since(o.fetched) > o.ttl {
		o.refreshLocked()
	}
	return o.set[a]
}

// Set replaces the address set (tests).
func (o *OwnAddrs) Set(addrs ...netip.Addr) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.set = map[netip.Addr]bool{}
	for _, a := range addrs {
		o.set[a.Unmap().WithZone("")] = true
	}
	o.fetched = time.Now().Add(100 * 365 * 24 * time.Hour)
}

func (o *OwnAddrs) refreshLocked() {
	set := map[netip.Addr]bool{}
	all, err := List()
	if err == nil {
		for _, i := range all {
			for _, p := range i.Prefixes {
				set[p.Addr().WithZone("")] = true
			}
		}
	}
	o.set = set
	o.fetched = time.Now()
}

// BindToDevice returns a ListenConfig control function that sets
// SO_REUSEADDR, SO_REUSEPORT and (best-effort) SO_BINDTODEVICE.
func BindToDevice(ifname string, reuse bool) func(network, address string, c syscall.RawConn) error {
	return func(network, address string, c syscall.RawConn) error {
		var serr error
		err := c.Control(func(fd uintptr) {
			if reuse {
				if e := syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1); e != nil {
					serr = e
					return
				}
				_ = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, soReusePort, 1)
				if network == "udp4" {
					// Only deliver multicast for groups joined on this socket.
					_ = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_IP, ipMulticastAll, 0)
				}
			}
			if ifname != "" {
				// Needs CAP_NET_RAW; callers also filter by IfIndex.
				_ = syscall.SetsockoptString(int(fd), syscall.SOL_SOCKET, syscall.SO_BINDTODEVICE, ifname)
			}
		})
		if err != nil {
			return err
		}
		return serr
	}
}

// SetBroadcast enables SO_BROADCAST on a UDP conn.
func SetBroadcast(c *net.UDPConn) error {
	rc, err := c.SyscallConn()
	if err != nil {
		return err
	}
	var serr error
	err = rc.Control(func(fd uintptr) {
		serr = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_BROADCAST, 1)
	})
	if err != nil {
		return err
	}
	return serr
}

// ListenUDP opens a UDP socket on addr with the device-binding options.
func ListenUDP(ctx context.Context, network, addr, ifname string, reuse bool) (*net.UDPConn, error) {
	lc := net.ListenConfig{Control: BindToDevice(ifname, reuse)}
	pc, err := lc.ListenPacket(ctx, network, addr)
	if err != nil {
		return nil, err
	}
	uc, ok := pc.(*net.UDPConn)
	if !ok {
		pc.Close()
		return nil, fmt.Errorf("not a UDP conn")
	}
	return uc, nil
}

// DirectedBroadcast returns the IPv4 broadcast address of p.
func DirectedBroadcast(p netip.Prefix) (netip.Addr, bool) {
	if !p.Addr().Is4() || p.Bits() >= 31 {
		return netip.Addr{}, false
	}
	b := p.Masked().Addr().As4()
	hostBits := 32 - p.Bits()
	v := uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
	v |= (1 << hostBits) - 1
	return netip.AddrFrom4([4]byte{byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)}), true
}
