package dnsd

import (
	"sync"
	"sync/atomic"
	"time"
)

// LogEntry is one element of a dns.queries event.
type LogEntry struct {
	Ts       int64    `json:"ts"`
	Client   string   `json:"client"`
	DeviceID string   `json:"device_id,omitempty"`
	QName    string   `json:"qname"`
	QType    string   `json:"qtype"`
	Action   string   `json:"action"`
	Cat      string   `json:"cat,omitempty"`
	Rule     string   `json:"rule,omitempty"`
	RCode    string   `json:"rcode"`
	Answers  []string `json:"answers"`
	Ms       int64    `json:"ms"`
	Cached   bool     `json:"cached"`
	Proto    string   `json:"proto"`
}

// Defaults for the query-log buffer.
const (
	QueryLogMax   = 20000
	QueryLogBatch = 500
)

// QueryLog is a bounded FIFO of log entries waiting to be shipped. When
// full, the oldest entries are dropped.
type QueryLog struct {
	mu      sync.Mutex
	ring    []LogEntry
	head    int
	count   int
	batch   int
	notify  chan struct{}
	dropped atomic.Uint64
}

// NewQueryLog creates a log holding up to max entries that signals Notify
// whenever batch entries are waiting.
func NewQueryLog(max, batch int) *QueryLog {
	return &QueryLog{ring: make([]LogEntry, max), batch: batch, notify: make(chan struct{}, 1)}
}

// Notify fires when a full batch is waiting.
func (q *QueryLog) Notify() <-chan struct{} { return q.notify }

// Len returns the number of buffered entries.
func (q *QueryLog) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.count
}

// Dropped returns how many entries were discarded because the buffer was full.
func (q *QueryLog) Dropped() uint64 { return q.dropped.Load() }

// Add appends an entry, dropping the oldest if the buffer is full.
func (q *QueryLog) Add(e LogEntry) {
	q.mu.Lock()
	max := len(q.ring)
	if q.count == max {
		q.ring[q.head] = LogEntry{}
		q.head = (q.head + 1) % max
		q.count--
		q.dropped.Add(1)
	}
	q.ring[(q.head+q.count)%max] = e
	q.count++
	full := q.count >= q.batch
	q.mu.Unlock()
	if full {
		select {
		case q.notify <- struct{}{}:
		default:
		}
	}
}

// Drain removes and returns up to n of the oldest entries.
func (q *QueryLog) Drain(n int) []LogEntry {
	q.mu.Lock()
	defer q.mu.Unlock()
	if n > q.count {
		n = q.count
	}
	if n <= 0 {
		return nil
	}
	out := make([]LogEntry, n)
	max := len(q.ring)
	for i := 0; i < n; i++ {
		idx := (q.head + i) % max
		out[i] = q.ring[idx]
		q.ring[idx] = LogEntry{}
	}
	q.head = (q.head + n) % max
	q.count -= n
	return out
}

// Requeue puts entries that could not be sent back at the front. If there is
// not room for all of them the oldest are dropped.
func (q *QueryLog) Requeue(es []LogEntry) {
	q.mu.Lock()
	defer q.mu.Unlock()
	max := len(q.ring)
	free := max - q.count
	if len(es) > free {
		q.dropped.Add(uint64(len(es) - free))
		es = es[len(es)-free:]
	}
	for i := len(es) - 1; i >= 0; i-- {
		q.head = (q.head - 1 + max) % max
		q.ring[q.head] = es[i]
		q.count++
	}
}

// Stats counts resolver activity.
type Stats struct {
	since          int64
	queries        atomic.Uint64
	blocked        atomic.Uint64
	wouldBlock     atomic.Uint64
	cacheHits      atomic.Uint64
	upstreamErrors atomic.Uint64

	mu      sync.Mutex
	buckets [60]uint32
	secs    [60]int64
}

// StatsSnapshot is the dns.stats result.
type StatsSnapshot struct {
	Since          int64   `json:"since"`
	Queries        uint64  `json:"queries"`
	Blocked        uint64  `json:"blocked"`
	WouldBlock     uint64  `json:"would_block"`
	CacheHits      uint64  `json:"cache_hits"`
	UpstreamErrors uint64  `json:"upstream_errors"`
	QPS1m          float64 `json:"qps_1m"`
}

// NewStats starts counting now.
func NewStats() *Stats { return &Stats{since: time.Now().UnixMilli()} }

func (s *Stats) query(now time.Time) {
	s.queries.Add(1)
	sec := now.Unix()
	i := sec % 60
	s.mu.Lock()
	if s.secs[i] != sec {
		s.secs[i] = sec
		s.buckets[i] = 0
	}
	s.buckets[i]++
	s.mu.Unlock()
}

// Snapshot returns current counters.
func (s *Stats) Snapshot() StatsSnapshot {
	now := time.Now().Unix()
	var total uint32
	s.mu.Lock()
	for i := range s.buckets {
		if now-s.secs[i] < 60 {
			total += s.buckets[i]
		}
	}
	s.mu.Unlock()
	return StatsSnapshot{
		Since:          s.since,
		Queries:        s.queries.Load(),
		Blocked:        s.blocked.Load(),
		WouldBlock:     s.wouldBlock.Load(),
		CacheHits:      s.cacheHits.Load(),
		UpstreamErrors: s.upstreamErrors.Load(),
		QPS1m:          float64(int(float64(total)/60*100+0.5)) / 100,
	}
}
