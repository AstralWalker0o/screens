package netx

import (
	"hash/fnv"
	"sync"
	"time"
)

// RateLimiter is a per-key token bucket (packets per second, burst = rate).
type RateLimiter struct {
	mu      sync.Mutex
	rate    float64
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
}

// NewRateLimiter creates a limiter; pps <= 0 means unlimited.
func NewRateLimiter(pps int) *RateLimiter {
	return &RateLimiter{rate: float64(pps), buckets: map[string]*bucket{}}
}

// SetRate changes the rate.
func (l *RateLimiter) SetRate(pps int) {
	l.mu.Lock()
	l.rate = float64(pps)
	l.mu.Unlock()
}

// Allow consumes a token for key.
func (l *RateLimiter) Allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.rate <= 0 {
		return true
	}
	b := l.buckets[key]
	if b == nil {
		b = &bucket{tokens: l.rate, last: now}
		l.buckets[key] = b
	}
	if el := now.Sub(b.last); el > 0 {
		b.tokens += el.Seconds() * l.rate
		if b.tokens > l.rate {
			b.tokens = l.rate
		}
		b.last = now
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// Dedup remembers content hashes for a short window.
type Dedup struct {
	mu     sync.Mutex
	window time.Duration
	seen   map[uint64]time.Time
	sweep  time.Time
}

// NewDedup creates a deduplicator with the given window.
func NewDedup(window time.Duration) *Dedup {
	return &Dedup{window: window, seen: map[uint64]time.Time{}}
}

// Hash returns the FNV-64a hash of b.
func Hash(b []byte) uint64 {
	h := fnv.New64a()
	_, _ = h.Write(b)
	return h.Sum64()
}

// Seen reports whether h was added within the window.
func (d *Dedup) Seen(h uint64, now time.Time) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	t, ok := d.seen[h]
	return ok && now.Sub(t) < d.window
}

// Add records h.
func (d *Dedup) Add(h uint64, now time.Time) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.seen[h] = now
	if now.Sub(d.sweep) > 10*d.window {
		for k, t := range d.seen {
			if now.Sub(t) >= d.window {
				delete(d.seen, k)
			}
		}
		d.sweep = now
	}
}
