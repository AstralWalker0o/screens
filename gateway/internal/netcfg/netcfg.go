// Package netcfg manages extra network legs for the gateway, configured from the cloud (net.configure):
//   - VLAN sub-interfaces on a trunked NIC (named "scr<vlan>", e.g. scr50 on eth0), and
//   - existing NICs the host left unconfigured (e.g. a second Proxmox NIC tagged for another VLAN).
//
// Addresses come from DHCP (address + prefix only: no routes, no DNS) or are static. Everything Screens
// creates is recreated from the persisted config on start and removed when dropped from the config.
package netcfg

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/netip"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Prefix names every VLAN interface Screens creates; only these are ever deleted.
const Prefix = "scr"

// Iface is one configured leg.
type Iface struct {
	Kind    string `json:"kind"`              // "vlan" | "existing"
	Parent  string `json:"parent,omitempty"`  // vlan: the trunked NIC
	VLAN    int    `json:"vlan,omitempty"`    // vlan: 1-4094
	Name    string `json:"name,omitempty"`    // existing: the NIC to configure
	Mode    string `json:"mode"`              // "dhcp" | "static"
	Address string `json:"address,omitempty"` // static: CIDR, e.g. 10.10.50.5/24
}

// Config is the net.configure payload.
type Config struct {
	Interfaces []Iface `json:"interfaces"`
}

// Status reports one leg.
type Status struct {
	Name    string   `json:"name"`
	Kind    string   `json:"kind"`
	Parent  string   `json:"parent,omitempty"`
	VLAN    int      `json:"vlan,omitempty"`
	Mode    string   `json:"mode"`
	State   string   `json:"state"` // up | acquiring | error
	Addrs   []string `json:"addrs"`
	Error   string   `json:"error,omitempty"`
	LeaseAt int64    `json:"lease_at,omitempty"`
	Expires int64    `json:"expires,omitempty"`
}

// Result is returned by Apply.
type Result struct {
	Interfaces []Status `json:"interfaces"`
	Errors     []string `json:"errors,omitempty"`
}

// LinkOps abstracts the kernel (netlink) so the reconcile logic is testable.
type LinkOps interface {
	// Link reports whether a link exists and, for VLANs, its parent and id.
	Link(name string) (exists bool, parent string, vlan int, err error)
	// Parent checks a NIC may carry VLANs / be configured (exists, Ethernet, not loopback/virtual bridges).
	Usable(name string) error
	AddVLAN(name, parent string, vlan int) error
	SetUp(name string) error
	Delete(name string) error
	// ReplaceAddr sets an IPv4 address with a lifetime (0 = forever).
	ReplaceAddr(name string, p netip.Prefix, lifetime time.Duration) error
	DelAddr(name string, p netip.Prefix) error
	// GlobalV4 lists the link's global IPv4 addresses.
	GlobalV4(name string) ([]netip.Prefix, error)
	// Managed lists links whose name starts with Prefix.
	Managed() ([]string, error)
}

// Acquirer obtains a DHCP lease (AcquireLease in production).
type Acquirer func(ctx context.Context, ifname string, prefer netip.Addr) (Lease, error)

var ifNameRe = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,15}$`)

type leg struct {
	cfg    Iface
	name   string
	cancel context.CancelFunc
	mu     sync.Mutex
	st     Status
	added  []netip.Prefix // addresses we put on an existing NIC (removed on drop)
}

// Manager reconciles the configured legs.
type Manager struct {
	ops     LinkOps
	acquire Acquirer
	log     *slog.Logger
	mu      sync.Mutex
	legs    map[string]*leg
	backoff []time.Duration
	// OnChange is called (async) when addresses change, so listeners can be re-expanded.
	OnChange func()
}

// New creates a Manager.
func New(ops LinkOps, acquire Acquirer, log *slog.Logger) *Manager {
	return &Manager{ops: ops, acquire: acquire, log: log, legs: map[string]*leg{}, backoff: []time.Duration{5 * time.Second, 15 * time.Second, 60 * time.Second}}
}

// ParseConfig decodes and validates a config.
func ParseConfig(raw json.RawMessage) (Config, error) {
	var c Config
	if len(raw) == 0 || string(raw) == "null" {
		return c, nil
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return c, err
	}
	if len(c.Interfaces) > 32 {
		return c, fmt.Errorf("too many interfaces (max 32)")
	}
	seen := map[string]bool{}
	for i := range c.Interfaces {
		f := &c.Interfaces[i]
		f.Kind = strings.ToLower(strings.TrimSpace(f.Kind))
		if f.Kind == "" {
			f.Kind = "vlan"
		}
		switch f.Kind {
		case "vlan":
			if !ifNameRe.MatchString(f.Parent) {
				return c, fmt.Errorf("interface %d: invalid parent %q", i, f.Parent)
			}
			if f.VLAN < 1 || f.VLAN > 4094 {
				return c, fmt.Errorf("interface %d: VLAN id must be 1-4094", i)
			}
		case "existing":
			if !ifNameRe.MatchString(f.Name) || strings.HasPrefix(f.Name, Prefix) {
				return c, fmt.Errorf("interface %d: invalid name %q", i, f.Name)
			}
		default:
			return c, fmt.Errorf("interface %d: kind must be vlan or existing", i)
		}
		if f.Mode != "dhcp" && f.Mode != "static" {
			return c, fmt.Errorf("interface %d: mode must be dhcp or static", i)
		}
		if f.Mode == "static" {
			p, err := netip.ParsePrefix(f.Address)
			if err != nil || !p.Addr().Is4() || !p.Addr().IsPrivate() || p.Bits() < 8 || p.Bits() > 30 {
				return c, fmt.Errorf("interface %d: static address must be a private IPv4 CIDR like 10.10.50.5/24", i)
			}
		}
		n := nameOf(*f)
		if seen[n] {
			return c, fmt.Errorf("interface %s is listed twice", n)
		}
		seen[n] = true
	}
	return c, nil
}

func nameOf(f Iface) string {
	if f.Kind == "existing" {
		return f.Name
	}
	return fmt.Sprintf("%s%d", Prefix, f.VLAN)
}

// Apply reconciles the kernel with cfg and returns the status of every leg.
func (m *Manager) Apply(cfg Config) Result {
	m.mu.Lock()
	defer m.mu.Unlock()
	var errs []string
	want := map[string]Iface{}
	for _, f := range cfg.Interfaces {
		want[nameOf(f)] = f
	}
	// Drop legs no longer configured.
	for name, l := range m.legs {
		if f, ok := want[name]; ok && f == l.cfg {
			continue
		}
		m.dropLocked(name, l)
	}
	// Remove stray scr* links (e.g. left over from an older config before a restart).
	if managed, err := m.ops.Managed(); err == nil {
		for _, n := range managed {
			if _, ok := want[n]; !ok {
				if err := m.ops.Delete(n); err != nil {
					errs = append(errs, fmt.Sprintf("remove %s: %v", n, err))
				}
			}
		}
	}
	for name, f := range want {
		if _, ok := m.legs[name]; ok {
			continue
		}
		l := &leg{cfg: f, name: name, st: Status{Name: name, Kind: f.Kind, Parent: f.Parent, VLAN: f.VLAN, Mode: f.Mode, State: "acquiring", Addrs: []string{}}}
		m.legs[name] = l
		if err := m.bringUp(l); err != nil {
			l.setErr(err)
			errs = append(errs, fmt.Sprintf("%s: %v", name, err))
			continue
		}
		ctx, cancel := context.WithCancel(context.Background())
		l.cancel = cancel
		if f.Mode == "static" {
			p := netip.MustParsePrefix(f.Address)
			if err := m.ops.ReplaceAddr(name, p, 0); err != nil {
				l.setErr(err)
				errs = append(errs, fmt.Sprintf("%s: %v", name, err))
				continue
			}
			l.mu.Lock()
			l.added = []netip.Prefix{p}
			l.st.State, l.st.Addrs = "up", []string{p.String()}
			l.mu.Unlock()
			m.changed()
		} else {
			go m.dhcpLoop(ctx, l)
		}
	}
	return Result{Interfaces: m.statusLocked(), Errors: errs}
}

func (m *Manager) bringUp(l *leg) error {
	f := l.cfg
	switch f.Kind {
	case "vlan":
		if err := m.ops.Usable(f.Parent); err != nil {
			return err
		}
		exists, parent, vlan, err := m.ops.Link(l.name)
		if err != nil {
			return err
		}
		if exists && (parent != f.Parent || vlan != f.VLAN) {
			if err := m.ops.Delete(l.name); err != nil {
				return err
			}
			exists = false
		}
		if !exists {
			if err := m.ops.AddVLAN(l.name, f.Parent, f.VLAN); err != nil {
				return fmt.Errorf("create VLAN %d on %s: %w (the NIC must carry tagged VLANs)", f.VLAN, f.Parent, err)
			}
		}
	case "existing":
		if err := m.ops.Usable(f.Name); err != nil {
			return err
		}
		// Never fight the host: refuse a NIC the OS already configured.
		addrs, err := m.ops.GlobalV4(f.Name)
		if err != nil {
			return err
		}
		if len(addrs) > 0 {
			return fmt.Errorf("%s is already configured by the host (%s); Screens only configures unconfigured NICs", f.Name, addrs[0])
		}
	}
	return m.ops.SetUp(l.name)
}

func (m *Manager) dhcpLoop(ctx context.Context, l *leg) {
	var prefer netip.Addr
	fails := 0
	for ctx.Err() == nil {
		actx, cancel := context.WithTimeout(ctx, 40*time.Second)
		lease, err := m.acquire(actx, l.name, prefer)
		cancel()
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			l.setErr(fmt.Errorf("DHCP: %w", err))
			d := m.backoff[min(fails, len(m.backoff)-1)]
			fails++
			m.log.Warn("dhcp failed", "iface", l.name, "err", err, "retry_in", d)
			if !sleepCtx(ctx, d) {
				return
			}
			continue
		}
		fails = 0
		// Lifetime slightly longer than the lease so the kernel drops it if we can no longer renew.
		if err := m.ops.ReplaceAddr(l.name, lease.Prefix, lease.Duration+30*time.Second); err != nil {
			l.setErr(err)
			if !sleepCtx(ctx, m.backoff[0]) {
				return
			}
			continue
		}
		l.mu.Lock()
		if prefer.IsValid() && prefer != lease.Prefix.Addr() {
			for _, old := range l.added {
				_ = m.ops.DelAddr(l.name, old)
			}
		}
		l.added = []netip.Prefix{lease.Prefix}
		l.st.State, l.st.Error, l.st.Addrs = "up", "", []string{lease.Prefix.String()}
		l.st.LeaseAt, l.st.Expires = time.Now().UnixMilli(), time.Now().Add(lease.Duration).UnixMilli()
		l.mu.Unlock()
		if lease.Prefix.Addr() != prefer {
			m.log.Info("dhcp lease", "iface", l.name, "addr", lease.Prefix, "lease", lease.Duration)
			m.changed()
		}
		prefer = lease.Prefix.Addr()
		renew := lease.Duration / 2
		if renew < 30*time.Second {
			renew = 30 * time.Second
		}
		if !sleepCtx(ctx, renew) {
			return
		}
	}
}

func (m *Manager) dropLocked(name string, l *leg) {
	if l.cancel != nil {
		l.cancel()
	}
	if l.cfg.Kind == "vlan" {
		_ = m.ops.Delete(name)
	} else {
		l.mu.Lock()
		for _, p := range l.added {
			_ = m.ops.DelAddr(name, p)
		}
		l.mu.Unlock()
	}
	delete(m.legs, name)
	m.changed()
}

func (m *Manager) changed() {
	if m.OnChange != nil {
		go m.OnChange()
	}
}

// Status returns every leg's status.
func (m *Manager) Status() []Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.statusLocked()
}

func (m *Manager) statusLocked() []Status {
	out := make([]Status, 0, len(m.legs))
	for _, l := range m.legs {
		l.mu.Lock()
		s := l.st
		s.Addrs = append([]string{}, l.st.Addrs...)
		l.mu.Unlock()
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Close stops DHCP loops (interfaces are left in place; the next start reconciles them).
func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, l := range m.legs {
		if l.cancel != nil {
			l.cancel()
		}
	}
}

func (l *leg) setErr(err error) {
	l.mu.Lock()
	l.st.State, l.st.Error = "error", err.Error()
	l.mu.Unlock()
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
