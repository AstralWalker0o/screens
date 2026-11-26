package netx

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Neighbor is one entry of the neighbour table.
type Neighbor struct {
	IP    string `json:"ip"`
	MAC   string `json:"mac"`
	Iface string `json:"iface"`
}

// ParseProcARP parses /proc/net/arp content. Incomplete entries (flags 0x0
// or all-zero MAC) are skipped.
func ParseProcARP(r io.Reader) []Neighbor {
	var out []Neighbor
	sc := bufio.NewScanner(r)
	first := true
	for sc.Scan() {
		if first {
			first = false
			continue // header
		}
		f := strings.Fields(sc.Text())
		if len(f) < 6 {
			continue
		}
		ip, mac, flags, dev := f[0], strings.ToLower(f[3]), f[2], f[5]
		if flags == "0x0" || mac == "00:00:00:00:00:00" {
			continue
		}
		if _, err := netip.ParseAddr(ip); err != nil {
			continue
		}
		out = append(out, Neighbor{IP: ip, MAC: mac, Iface: dev})
	}
	return out
}

// ParseIPNeigh parses `ip -6 neigh` output lines such as
// "fe80::1 dev eth0 lladdr aa:bb:cc:dd:ee:ff router REACHABLE".
func ParseIPNeigh(r io.Reader) []Neighbor {
	var out []Neighbor
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 1 {
			continue
		}
		var n Neighbor
		n.IP = f[0]
		if _, err := netip.ParseAddr(n.IP); err != nil {
			continue
		}
		state := ""
		for i := 1; i < len(f); i++ {
			switch f[i] {
			case "dev":
				if i+1 < len(f) {
					n.Iface = f[i+1]
					i++
				}
			case "lladdr":
				if i+1 < len(f) {
					n.MAC = strings.ToLower(f[i+1])
					i++
				}
			default:
				state = f[i]
			}
		}
		if n.MAC == "" || state == "FAILED" || state == "INCOMPLETE" {
			continue
		}
		if _, err := net.ParseMAC(n.MAC); err != nil {
			continue
		}
		out = append(out, n)
	}
	return out
}

// ProcARPPath is replaceable in tests.
var ProcARPPath = "/proc/net/arp"

// Neighbors returns the IPv4 ARP table plus `ip -6 neigh` if available.
func Neighbors(ctx context.Context) []Neighbor {
	out := []Neighbor{}
	if b, err := os.ReadFile(ProcARPPath); err == nil {
		out = append(out, ParseProcARP(bytes.NewReader(b))...)
	}
	if path, err := exec.LookPath("ip"); err == nil {
		cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		if b, err := exec.CommandContext(cctx, path, "-6", "neigh", "show").Output(); err == nil {
			out = append(out, ParseIPNeigh(bytes.NewReader(b))...)
		}
	}
	return out
}

// MACTable maps IP → MAC from the current neighbour table.
func MACTable(ctx context.Context) map[string]string {
	m := map[string]string{}
	for _, n := range Neighbors(ctx) {
		m[n.IP] = n.MAC
	}
	return m
}
