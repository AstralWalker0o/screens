package dnsd

import (
	"net"
	"testing"
	"time"

	"github.com/miekg/dns"
)

func aResponse(name string, ttl uint32, ip string) (*dns.Msg, *dns.Msg) {
	q := new(dns.Msg)
	q.SetQuestion(dns.Fqdn(name), dns.TypeA)
	r := new(dns.Msg)
	r.SetReply(q)
	r.Answer = []dns.RR{&dns.A{Hdr: dns.RR_Header{Name: dns.Fqdn(name), Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: ttl}, A: net.ParseIP(ip)}}
	return q, r
}

func TestCacheTTL(t *testing.T) {
	c := NewCache(10, 0, 86400)
	now := time.Unix(1000, 0)
	q, r := aResponse("a.example", 100, "10.0.0.1")
	key := CacheKey(q)
	c.Put(key, r, now)
	got := c.Get(key, now.Add(30*time.Second))
	if got == nil || got.Answer[0].Header().Ttl != 70 {
		t.Fatalf("ttl decrement: %v", got)
	}
	// Stored copy is unaffected by mutation of the returned copy.
	got.Answer[0].Header().Ttl = 1
	if g2 := c.Get(key, now.Add(30*time.Second)); g2.Answer[0].Header().Ttl != 70 {
		t.Fatal("cache entry mutated")
	}
	if c.Get(key, now.Add(100*time.Second)) != nil {
		t.Fatal("not expired")
	}
	if c.Len() != 0 {
		t.Fatal("expired entry not removed")
	}
}

func TestCacheClampAndKeys(t *testing.T) {
	c := NewCache(10, 60, 300)
	now := time.Unix(1000, 0)
	q, r := aResponse("short.example", 5, "10.0.0.1")
	c.Put(CacheKey(q), r, now)
	if c.Get(CacheKey(q), now.Add(30*time.Second)) == nil {
		t.Fatal("min_ttl not applied")
	}
	q2, r2 := aResponse("long.example", 100000, "10.0.0.2")
	c.Put(CacheKey(q2), r2, now)
	if c.Get(CacheKey(q2), now.Add(301*time.Second)) != nil {
		t.Fatal("max_ttl not applied")
	}
	// EDNS and DO bit are part of the key; name case is not.
	q3 := q.Copy()
	q3.SetEdns0(1232, true)
	if CacheKey(q3) == CacheKey(q) {
		t.Fatal("edns not in key")
	}
	q4 := new(dns.Msg)
	q4.SetQuestion("SHORT.Example.", dns.TypeA)
	if CacheKey(q4) != CacheKey(q) {
		t.Fatal("case-sensitive key")
	}
	// SERVFAIL never cached.
	sf := new(dns.Msg)
	sf.SetRcode(q, dns.RcodeServerFailure)
	c.Flush()
	c.Put(CacheKey(q), sf, now)
	if c.Len() != 0 {
		t.Fatal("servfail cached")
	}
	// NXDOMAIN uses SOA minimum.
	nx := new(dns.Msg)
	nx.SetRcode(q, dns.RcodeNameError)
	nx.Ns = []dns.RR{&dns.SOA{Hdr: dns.RR_Header{Name: "example.", Rrtype: dns.TypeSOA, Class: dns.ClassINET, Ttl: 3600}, Minttl: 120}}
	c2 := NewCache(10, 0, 86400)
	c2.Put(CacheKey(q), nx, now)
	if c2.Get(CacheKey(q), now.Add(119*time.Second)) == nil || c2.Get(CacheKey(q), now.Add(121*time.Second)) != nil {
		t.Fatal("negative ttl")
	}
}

func TestCacheLRU(t *testing.T) {
	c := NewCache(2, 0, 86400)
	now := time.Unix(1000, 0)
	qa, ra := aResponse("a.example", 100, "10.0.0.1")
	qb, rb := aResponse("b.example", 100, "10.0.0.2")
	qc, rc := aResponse("c.example", 100, "10.0.0.3")
	c.Put(CacheKey(qa), ra, now)
	c.Put(CacheKey(qb), rb, now)
	c.Get(CacheKey(qa), now) // a is now most recent
	c.Put(CacheKey(qc), rc, now)
	if c.Get(CacheKey(qb), now) != nil {
		t.Fatal("b should be evicted")
	}
	if c.Get(CacheKey(qa), now) == nil || c.Get(CacheKey(qc), now) == nil {
		t.Fatal("a/c missing")
	}
}

func TestQueryLog(t *testing.T) {
	q := NewQueryLog(5, 3)
	for i := 0; i < 2; i++ {
		q.Add(LogEntry{Ts: int64(i)})
	}
	select {
	case <-q.Notify():
		t.Fatal("notified early")
	default:
	}
	q.Add(LogEntry{Ts: 2})
	select {
	case <-q.Notify():
	default:
		t.Fatal("no notify at batch size")
	}
	for i := 3; i < 8; i++ {
		q.Add(LogEntry{Ts: int64(i)})
	}
	if q.Len() != 5 || q.Dropped() != 3 {
		t.Fatalf("len %d dropped %d", q.Len(), q.Dropped())
	}
	got := q.Drain(2)
	if got[0].Ts != 3 || got[1].Ts != 4 {
		t.Fatalf("drain %v", got)
	}
	q.Requeue(got)
	all := q.Drain(10)
	if len(all) != 5 || all[0].Ts != 3 || all[4].Ts != 7 {
		t.Fatalf("after requeue %v", all)
	}
	// Requeue more than fits keeps the newest of the requeued batch.
	for i := 10; i < 14; i++ {
		q.Add(LogEntry{Ts: int64(i)})
	}
	q.Requeue([]LogEntry{{Ts: 1}, {Ts: 2}, {Ts: 3}})
	all = q.Drain(10)
	if len(all) != 5 || all[0].Ts != 3 || all[1].Ts != 10 {
		t.Fatalf("overflow requeue %v", all)
	}
}

func TestStats(t *testing.T) {
	s := NewStats()
	now := time.Now()
	for i := 0; i < 120; i++ {
		s.query(now)
	}
	snap := s.Snapshot()
	if snap.Queries != 120 || snap.QPS1m != 2 {
		t.Fatalf("%+v", snap)
	}
}
