package dnsd

import (
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"strings"
)

const (
	flagBlock uint8 = 1 << iota
	flagAllow
)

type mentry struct {
	flags uint8
	bcat  uint16
	acat  uint16
}

// Matcher is a compiled domain-suffix rule set. A rule for "example.com"
// matches itself and every subdomain. Lookups walk from the full name
// towards the TLD and stop at the most specific level that has a rule; at
// that level an allow beats a block.
type Matcher struct {
	m     map[string]mentry
	cats  []string
	rules int
}

// Verdicts returned by Match.
const (
	VerdictNone  = 0
	VerdictAllow = 'a'
	VerdictBlock = 'b'
)

// NewMatcher creates an empty matcher.
func NewMatcher(sizeHint int) *Matcher {
	return &Matcher{m: make(map[string]mentry, sizeHint), cats: []string{""}}
}

// Rules returns the number of rule lines compiled.
func (m *Matcher) Rules() int { return m.rules }

func (m *Matcher) catIndex(c string, idx map[string]uint16) uint16 {
	if c == "" {
		return 0
	}
	if i, ok := idx[c]; ok {
		return i
	}
	if len(m.cats) >= 0xffff {
		return 0
	}
	i := uint16(len(m.cats))
	m.cats = append(m.cats, c)
	idx[c] = i
	return i
}

// Add inserts a rule. verdict is VerdictAllow or VerdictBlock.
func (m *Matcher) Add(verdict byte, domain, cat string, idx map[string]uint16) {
	d := NormalizeDomain(domain)
	if d == "" {
		return
	}
	e := m.m[d]
	switch verdict {
	case VerdictBlock:
		e.flags |= flagBlock
		e.bcat = m.catIndex(cat, idx)
	case VerdictAllow:
		e.flags |= flagAllow
		e.acat = m.catIndex(cat, idx)
	default:
		return
	}
	m.m[d] = e
	m.rules++
}

// Match looks up a lower-case qname (no trailing dot). It returns the
// verdict, the matching rule domain and the category tag.
func (m *Matcher) Match(qname string) (verdict byte, rule, cat string) {
	if m == nil || len(m.m) == 0 {
		return VerdictNone, "", ""
	}
	name := qname
	for {
		if e, ok := m.m[name]; ok {
			if e.flags&flagAllow != 0 {
				return VerdictAllow, name, m.cats[e.acat]
			}
			return VerdictBlock, name, m.cats[e.bcat]
		}
		i := strings.IndexByte(name, '.')
		if i < 0 {
			return VerdictNone, "", ""
		}
		name = name[i+1:]
	}
}

// ParsePolicy compiles policy text: one rule per line, "#" comments,
// "b <domain> [cat]" or "a <domain> [cat]". Unknown verbs are ignored.
// Keys are substrings of text, so the text is retained by the matcher.
func ParsePolicy(text string) *Matcher {
	m := NewMatcher(strings.Count(text, "\n") + 1)
	idx := map[string]uint16{}
	for len(text) > 0 {
		var line string
		if i := strings.IndexByte(text, '\n'); i >= 0 {
			line, text = text[:i], text[i+1:]
		} else {
			line, text = text, ""
		}
		line = strings.TrimSpace(line)
		if line == "" || line[0] == '#' {
			continue
		}
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = strings.TrimSpace(line[:i])
		}
		verb, rest := cut(line)
		if len(verb) != 1 || (verb[0] != VerdictAllow && verb[0] != VerdictBlock) {
			continue
		}
		domain, rest := cut(rest)
		cat, _ := cut(rest)
		m.Add(verb[0], domain, cat, idx)
	}
	return m
}

// cut splits off the first whitespace-separated field.
func cut(s string) (field, rest string) {
	s = strings.TrimLeft(s, " \t")
	i := strings.IndexAny(s, " \t")
	if i < 0 {
		return s, ""
	}
	return s[:i], strings.TrimLeft(s[i:], " \t")
}

// maxPolicyBytes caps the decompressed size of a policy file.
const maxPolicyBytes = 512 << 20

// LoadPolicyFile reads and compiles a gzip'd policy file.
func LoadPolicyFile(path string) (*Matcher, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		return nil, fmt.Errorf("policy %s: %w", path, err)
	}
	defer zr.Close()
	var sb strings.Builder
	if st, err := f.Stat(); err == nil {
		sb.Grow(int(st.Size()) * 3)
	}
	n, err := io.Copy(&sb, io.LimitReader(zr, maxPolicyBytes+1))
	if err != nil {
		return nil, fmt.Errorf("policy %s: %w", path, err)
	}
	if n > maxPolicyBytes {
		return nil, fmt.Errorf("policy %s: larger than %d bytes", path, maxPolicyBytes)
	}
	return ParsePolicy(sb.String()), nil
}

// InlineMatcher compiles per-client allow/block lists.
func InlineMatcher(allow, block []string) *Matcher {
	if len(allow) == 0 && len(block) == 0 {
		return nil
	}
	m := NewMatcher(len(allow) + len(block))
	idx := map[string]uint16{}
	for _, d := range block {
		m.Add(VerdictBlock, d, "", idx)
	}
	for _, d := range allow {
		m.Add(VerdictAllow, d, "", idx)
	}
	return m
}
