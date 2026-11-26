package netcfg

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"time"

	"github.com/vishvananda/netlink"
	"golang.org/x/sys/unix"
)

// Netlink is the production LinkOps.
type Netlink struct{}

func (Netlink) Link(name string) (bool, string, int, error) {
	l, err := netlink.LinkByName(name)
	if err != nil {
		if _, ok := err.(netlink.LinkNotFoundError); ok {
			return false, "", 0, nil
		}
		return false, "", 0, err
	}
	v, ok := l.(*netlink.Vlan)
	if !ok {
		return true, "", 0, nil
	}
	parent := ""
	if p, err := netlink.LinkByIndex(v.ParentIndex); err == nil {
		parent = p.Attrs().Name
	}
	return true, parent, v.VlanId, nil
}

var virtualPrefixes = []string{"lo", "docker", "br-", "veth", "cni", "flannel", "tailscale", "wg", "tun", "tap", "virbr", "zt"}

func (Netlink) Usable(name string) error {
	for _, p := range virtualPrefixes {
		if name == "lo" || (p != "lo" && strings.HasPrefix(name, p)) {
			return fmt.Errorf("%s is a virtual/loopback interface and can't be used", name)
		}
	}
	l, err := netlink.LinkByName(name)
	if err != nil {
		return fmt.Errorf("interface %s not found on the gateway host", name)
	}
	if len(l.Attrs().HardwareAddr) != 6 {
		return fmt.Errorf("%s is not an Ethernet interface", name)
	}
	return nil
}

func (Netlink) AddVLAN(name, parent string, vlan int) error {
	p, err := netlink.LinkByName(parent)
	if err != nil {
		return fmt.Errorf("network port %s not found", parent)
	}
	attrs := netlink.NewLinkAttrs()
	attrs.Name = name
	attrs.ParentIndex = p.Attrs().Index
	err = netlink.LinkAdd(&netlink.Vlan{LinkAttrs: attrs, VlanId: vlan, VlanProtocol: netlink.VLAN_PROTOCOL_8021Q})
	if errors.Is(err, unix.EOPNOTSUPP) || (err != nil && strings.Contains(err.Error(), "not supported")) {
		return fmt.Errorf("this machine's kernel has no VLAN support loaded; run 'sudo modprobe 8021q' on it (and add 8021q to /etc/modules), or use a separate network device for the VLAN instead")
	}
	return err
}

func (Netlink) SetUp(name string) error {
	l, err := netlink.LinkByName(name)
	if err != nil {
		return err
	}
	return netlink.LinkSetUp(l)
}

func (Netlink) Delete(name string) error {
	if !strings.HasPrefix(name, Prefix) {
		return fmt.Errorf("refusing to delete %s (not created by Screens)", name)
	}
	l, err := netlink.LinkByName(name)
	if err != nil {
		if _, ok := err.(netlink.LinkNotFoundError); ok {
			return nil
		}
		return err
	}
	return netlink.LinkDel(l)
}

func toAddr(p netip.Prefix) *netlink.Addr {
	a := p.Addr().As4()
	return &netlink.Addr{IPNet: &net.IPNet{IP: net.IP(a[:]), Mask: net.CIDRMask(p.Bits(), 32)}}
}

func (Netlink) ReplaceAddr(name string, p netip.Prefix, lifetime time.Duration) error {
	l, err := netlink.LinkByName(name)
	if err != nil {
		return err
	}
	a := toAddr(p)
	if lifetime > 0 {
		s := int(lifetime / time.Second)
		a.ValidLft, a.PreferedLft = s, s
	}
	return netlink.AddrReplace(l, a)
}

func (Netlink) DelAddr(name string, p netip.Prefix) error {
	l, err := netlink.LinkByName(name)
	if err != nil {
		return err
	}
	return netlink.AddrDel(l, toAddr(p))
}

func (Netlink) GlobalV4(name string) ([]netip.Prefix, error) {
	l, err := netlink.LinkByName(name)
	if err != nil {
		return nil, err
	}
	addrs, err := netlink.AddrList(l, netlink.FAMILY_V4)
	if err != nil {
		return nil, err
	}
	var out []netip.Prefix
	for _, a := range addrs {
		ip, ok := netip.AddrFromSlice(a.IP.To4())
		if !ok || ip.IsLinkLocalUnicast() || ip.IsLoopback() {
			continue
		}
		ones, _ := a.Mask.Size()
		out = append(out, netip.PrefixFrom(ip, ones))
	}
	return out, nil
}

func (Netlink) Managed() ([]string, error) {
	links, err := netlink.LinkList()
	if err != nil {
		return nil, err
	}
	var out []string
	for _, l := range links {
		if _, ok := l.(*netlink.Vlan); ok && strings.HasPrefix(l.Attrs().Name, Prefix) {
			out = append(out, l.Attrs().Name)
		}
	}
	return out, nil
}
