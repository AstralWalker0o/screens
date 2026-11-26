// Package mdns is the mDNS reflector (PROTOCOL.md §5 mDNS / SSDP
// reflector): per-interface multicast sockets, rule-based reflection with
// service-type allow/deny, QU-bit clearing, loop prevention, rate limiting
// and a service tracker. Packet matching is kept in pure functions here.
package mdns

import (
	"strconv"
	"strings"

	"github.com/miekg/dns"
)

// ServiceType returns the DNS-SD service type ("_googlecast._tcp") a name
// ends with, or "" if it has none. Sub-type names
// ("_printer._sub._http._tcp.local") yield the parent type.
func ServiceType(name string) string {
	labels := dns.SplitDomainName(name)
	for i := len(labels) - 1; i >= 1; i-- {
		l := strings.ToLower(labels[i])
		if l == "_tcp" || l == "_udp" {
			prev := strings.ToLower(labels[i-1])
			if strings.HasPrefix(prev, "_") {
				return prev + "." + l
			}
			return ""
		}
	}
	return ""
}

// NormalizeType canonicalises an allow/deny entry ("_Sonos._tcp.local." →
// "_sonos._tcp"; "*" stays "*").
func NormalizeType(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.TrimSuffix(s, ".")
	s = strings.TrimSuffix(s, ".local")
	return s
}

// Names returns every name in a message that matching considers: question
// names, owner names in all sections, and PTR targets.
func Names(m *dns.Msg) []string {
	var out []string
	for _, q := range m.Question {
		out = append(out, q.Name)
	}
	for _, sec := range [][]dns.RR{m.Answer, m.Ns, m.Extra} {
		for _, rr := range sec {
			h := rr.Header()
			if h.Rrtype == dns.TypeOPT {
				continue
			}
			out = append(out, h.Name)
			if p, ok := rr.(*dns.PTR); ok {
				out = append(out, p.Ptr)
			}
		}
	}
	return out
}

// Rule is a compiled reflection rule.
type Rule struct {
	From     string
	To       []string
	allow    map[string]bool
	deny     map[string]bool
	allowAll bool
	denyAll  bool
}

// CompileRule builds a Rule from allow/deny lists.
func CompileRule(from string, to, allow, deny []string) Rule {
	r := Rule{From: from, To: to, allow: map[string]bool{}, deny: map[string]bool{}}
	for _, a := range allow {
		a = NormalizeType(a)
		if a == "*" {
			r.allowAll = true
		} else if a != "" {
			r.allow[a] = true
		}
	}
	for _, d := range deny {
		d = NormalizeType(d)
		if d == "*" {
			r.denyAll = true
		} else if d != "" {
			r.deny[d] = true
		}
	}
	return r
}

// Allows reports whether a service type passes the rule's lists.
func (r Rule) Allows(st string) bool {
	if r.denyAll || r.deny[st] {
		return false
	}
	return r.allowAll || r.allow[st]
}

// HostSeenFunc reports whether a host name was seen as the target of an SRV
// record (within the tracking window) whose service type the rule allows.
type HostSeenFunc func(host string, r Rule) bool

func isReverseName(n string) bool {
	n = strings.ToLower(strings.TrimSuffix(n, "."))
	return strings.HasSuffix(n, ".in-addr.arpa") || strings.HasSuffix(n, ".ip6.arpa")
}

// Match decides whether a packet may be reflected under rule r:
//   - if any name carries a service type: no name may end with a denied
//     type and at least one must end with an allowed type;
//   - otherwise (plain host queries/answers): allowed if the rule allows
//     "*", or if every host name in the packet was seen as an SRV target of
//     an allowed service (reverse-mapping names are ignored, but at least
//     one seen host is required).
func Match(m *dns.Msg, r Rule, seen HostSeenFunc) bool {
	names := Names(m)
	if len(names) == 0 {
		return false
	}
	hasType, allowed := false, false
	for _, n := range names {
		st := ServiceType(n)
		if st == "" {
			continue
		}
		hasType = true
		if r.denyAll || r.deny[st] {
			return false
		}
		if r.allowAll || r.allow[st] {
			allowed = true
		}
	}
	if hasType {
		return allowed
	}
	if r.allowAll {
		return true
	}
	if seen == nil {
		return false
	}
	found := false
	for _, n := range names {
		if isReverseName(n) {
			continue
		}
		if !seen(n, r) {
			return false
		}
		found = true
	}
	return found
}

// StripDenied returns a copy of m without the questions and records whose
// service type the rule denies (owner names and PTR targets), and whether
// anything was removed. Host address records are kept: one host often serves
// several services (an Apple TV announces both _airplay and _hap), so denying
// one service must not hide the others.
func StripDenied(m *dns.Msg, r Rule) (*dns.Msg, bool) {
	if r.denyAll || len(r.deny) == 0 {
		return m, false
	}
	denied := func(name string) bool {
		st := ServiceType(name)
		return st != "" && r.deny[st]
	}
	hit := false
	for _, n := range Names(m) {
		if denied(n) {
			hit = true
			break
		}
	}
	if !hit {
		return m, false
	}
	c := m.Copy()
	qs := c.Question[:0]
	for _, q := range c.Question {
		if !denied(q.Name) {
			qs = append(qs, q)
		}
	}
	c.Question = qs
	keep := func(rrs []dns.RR) []dns.RR {
		out := rrs[:0]
		for _, rr := range rrs {
			if denied(rr.Header().Name) {
				continue
			}
			if p, ok := rr.(*dns.PTR); ok && denied(p.Ptr) {
				continue
			}
			out = append(out, rr)
		}
		return out
	}
	c.Answer, c.Ns, c.Extra = keep(c.Answer), keep(c.Ns), keep(c.Extra)
	return c, true
}

// ClearQU clears the unicast-response bit of every question. It reports
// whether anything changed.
func ClearQU(m *dns.Msg) bool {
	changed := false
	for i := range m.Question {
		if m.Question[i].Qclass&0x8000 != 0 {
			m.Question[i].Qclass &^= 0x8000
			changed = true
		}
	}
	return changed
}

// PrepareForReflection returns the bytes to send: for queries with the QU
// bit set, a re-packed copy with it cleared (changed=true); otherwise the
// original packet.
func PrepareForReflection(m *dns.Msg, raw []byte) (out []byte, changed bool) {
	if m.Response {
		return raw, false
	}
	c := m.Copy()
	if !ClearQU(c) {
		return raw, false
	}
	c.Compress = true
	out, err := c.Pack()
	if err != nil {
		return raw, false
	}
	return out, true
}

// Unescape converts a presentation-format label or TXT string
// ("Living\032Room", "a\"b") to its raw text.
func Unescape(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c != '\\' || i+1 >= len(s) {
			b.WriteByte(c)
			continue
		}
		if i+3 < len(s) && isDigit(s[i+1]) && isDigit(s[i+2]) && isDigit(s[i+3]) {
			v, _ := strconv.Atoi(s[i+1 : i+4])
			b.WriteByte(byte(v))
			i += 3
			continue
		}
		b.WriteByte(s[i+1])
		i++
	}
	return b.String()
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

// InstanceLabel returns the human-readable instance part of a full service
// instance name ("Living\032Room._sonos._tcp.local." → "Living Room").
func InstanceLabel(full, service string) string {
	labels := dns.SplitDomainName(full)
	parts := strings.SplitN(service, ".", 2)
	if len(parts) == 2 {
		for i := len(labels) - 2; i > 0; i-- {
			if strings.ToLower(labels[i]) == parts[0] && strings.ToLower(labels[i+1]) == parts[1] {
				return Unescape(strings.Join(labels[:i], "."))
			}
		}
	}
	if len(labels) > 0 {
		return Unescape(labels[0])
	}
	return ""
}

// TrimDot removes the trailing dot of a FQDN.
func TrimDot(s string) string { return strings.TrimSuffix(s, ".") }
