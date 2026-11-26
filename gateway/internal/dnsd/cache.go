package dnsd

import (
	"container/list"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/miekg/dns"
)

// Cache is a TTL-respecting LRU cache of upstream responses.
type Cache struct {
	mu     sync.Mutex
	max    int
	minTTL uint32
	maxTTL uint32
	ll     *list.List
	m      map[string]*list.Element
}

type cacheEntry struct {
	key     string
	msg     *dns.Msg
	stored  time.Time
	expires time.Time
}

// NewCache creates a cache.
func NewCache(max int, minTTL, maxTTL uint32) *Cache {
	c := &Cache{ll: list.New(), m: map[string]*list.Element{}}
	c.Configure(max, minTTL, maxTTL)
	return c
}

// Configure changes limits, evicting if needed.
func (c *Cache) Configure(max int, minTTL, maxTTL uint32) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if max < 1 {
		max = 1
	}
	c.max, c.minTTL, c.maxTTL = max, minTTL, maxTTL
	for c.ll.Len() > c.max {
		c.removeOldest()
	}
}

// Len returns the number of entries.
func (c *Cache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ll.Len()
}

// Flush empties the cache.
func (c *Cache) Flush() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ll.Init()
	c.m = map[string]*list.Element{}
}

func (c *Cache) removeOldest() {
	e := c.ll.Back()
	if e == nil {
		return
	}
	c.ll.Remove(e)
	delete(c.m, e.Value.(*cacheEntry).key)
}

// CacheKey identifies a query for caching.
func CacheKey(req *dns.Msg) string {
	if len(req.Question) != 1 {
		return ""
	}
	q := req.Question[0]
	var b strings.Builder
	b.WriteString(strings.ToLower(q.Name))
	b.WriteByte('|')
	b.WriteString(strconv.Itoa(int(q.Qtype)))
	b.WriteByte('|')
	b.WriteString(strconv.Itoa(int(q.Qclass)))
	b.WriteByte('|')
	if opt := req.IsEdns0(); opt != nil {
		b.WriteByte('e')
		if opt.Do() {
			b.WriteByte('d')
		}
	}
	if req.CheckingDisabled {
		b.WriteByte('c')
	}
	return b.String()
}

// ttlFor computes the cache lifetime of a response, or ok=false if it must
// not be cached.
func ttlFor(m *dns.Msg) (ttl uint32, ok bool) {
	if m.Truncated {
		return 0, false
	}
	switch m.Rcode {
	case dns.RcodeSuccess, dns.RcodeNameError:
	default:
		return 0, false
	}
	min := uint32(0)
	have := false
	consider := func(rrs []dns.RR) {
		for _, rr := range rrs {
			h := rr.Header()
			if h.Rrtype == dns.TypeOPT {
				continue
			}
			t := h.Ttl
			if soa, isSOA := rr.(*dns.SOA); isSOA && soa.Minttl < t {
				t = soa.Minttl
			}
			if !have || t < min {
				min, have = t, true
			}
		}
	}
	consider(m.Answer)
	consider(m.Ns)
	if !have {
		// Negative answer without SOA: cache briefly.
		return 30, true
	}
	return min, true
}

// Get returns a copy of a cached response with TTLs reduced by its age.
func (c *Cache) Get(key string, now time.Time) *dns.Msg {
	if key == "" {
		return nil
	}
	c.mu.Lock()
	el, ok := c.m[key]
	if !ok {
		c.mu.Unlock()
		return nil
	}
	ent := el.Value.(*cacheEntry)
	if !now.Before(ent.expires) {
		// Expired entries stay (LRU-evicted) so they can be served stale
		// when every upstream is unreachable.
		if now.Sub(ent.expires) > MaxStale {
			c.ll.Remove(el)
			delete(c.m, key)
		}
		c.mu.Unlock()
		return nil
	}
	c.ll.MoveToFront(el)
	msg := ent.msg.Copy()
	age := uint32(now.Sub(ent.stored) / time.Second)
	c.mu.Unlock()
	setTTL(msg, func(t uint32) uint32 {
		if t > age {
			return t - age
		}
		return 0
	})
	return msg
}

// MaxStale is how long past expiry an entry may still be served stale.
const MaxStale = 24 * time.Hour

// StaleTTL is the TTL given to answers served stale (RFC 8767 §4).
const StaleTTL = 30

// GetStale returns an expired (or live) entry with TTLs set to StaleTTL,
// for use when resolution fails.
func (c *Cache) GetStale(key string, now time.Time) *dns.Msg {
	if key == "" {
		return nil
	}
	c.mu.Lock()
	el, ok := c.m[key]
	if !ok {
		c.mu.Unlock()
		return nil
	}
	ent := el.Value.(*cacheEntry)
	if now.Sub(ent.expires) > MaxStale {
		c.mu.Unlock()
		return nil
	}
	msg := ent.msg.Copy()
	c.mu.Unlock()
	setTTL(msg, func(uint32) uint32 { return StaleTTL })
	return msg
}

func setTTL(msg *dns.Msg, f func(uint32) uint32) {
	for _, sec := range [][]dns.RR{msg.Answer, msg.Ns, msg.Extra} {
		for _, rr := range sec {
			h := rr.Header()
			if h.Rrtype == dns.TypeOPT {
				continue
			}
			h.Ttl = f(h.Ttl)
		}
	}
}

// Put stores a response if cacheable. TTL is clamped to [min,max].
func (c *Cache) Put(key string, m *dns.Msg, now time.Time) {
	if key == "" {
		return
	}
	ttl, ok := ttlFor(m)
	if !ok {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if ttl < c.minTTL {
		ttl = c.minTTL
	}
	if ttl > c.maxTTL {
		ttl = c.maxTTL
	}
	if ttl == 0 {
		return
	}
	ent := &cacheEntry{key: key, msg: m.Copy(), stored: now, expires: now.Add(time.Duration(ttl) * time.Second)}
	if el, ok := c.m[key]; ok {
		el.Value = ent
		c.ll.MoveToFront(el)
		return
	}
	c.m[key] = c.ll.PushFront(ent)
	for c.ll.Len() > c.max {
		c.removeOldest()
	}
}
