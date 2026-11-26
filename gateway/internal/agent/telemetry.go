package agent

import (
	"context"
	"path/filepath"
	"runtime"
	"time"

	"github.com/astralwalker0o/screens/gateway/internal/dnsd"
	"github.com/astralwalker0o/screens/gateway/internal/mdns"
	"github.com/astralwalker0o/screens/gateway/internal/netx"
	"github.com/astralwalker0o/screens/gateway/internal/ops"
	"github.com/astralwalker0o/screens/gateway/internal/proto"
)

// MDNSServicesInterval is the mdns.services check interval (§5).
var MDNSServicesInterval = 60 * time.Second

func ms(v int64) time.Duration { return time.Duration(v) * time.Millisecond }

func (a *Agent) telemetryLoop(ctx context.Context) {
	var lastFP uint64
	for {
		t := *a.telemetry.Load()
		dnsT := time.NewTicker(ms(t.DNSBatchMs))
		metT := time.NewTicker(ms(t.MetricsMs))
		neiT := time.NewTicker(ms(t.NeighborsMs))
		mdnsT := time.NewTicker(MDNSServicesInterval)
		stop := func() { dnsT.Stop(); metT.Stop(); neiT.Stop(); mdnsT.Stop() }
	inner:
		for {
			select {
			case <-ctx.Done():
				stop()
				a.flushDNS()
				return
			case <-a.teleChanged:
				break inner
			case <-a.linkUp:
				a.flushDNS()
				a.sendMetrics()
				lastFP = 0
			case <-dnsT.C:
				a.flushDNS()
			case <-a.dns.QueryLog().Notify():
				a.flushDNS()
			case <-metT.C:
				a.sendMetrics()
			case <-neiT.C:
				a.sendEvent("neighbors", map[string]any{"entries": netx.Neighbors(ctx)})
			case <-mdnsT.C:
				list := a.mdns.Services()
				fp := mdns.Fingerprint(list)
				if fp != lastFP && (len(list) > 0 || lastFP != 0) {
					if a.sendEvent("mdns.services", map[string]any{"services": list}) {
						lastFP = fp
					}
				}
			}
		}
		stop()
	}
}

func (a *Agent) sendEvent(typ string, data any) bool {
	l := a.link.Load()
	if l == nil {
		return false
	}
	return l.SendEvent(typ, data)
}

func (a *Agent) sendMetrics() {
	a.sendEvent("metrics", map[string]any{
		"uptime_s":   int64(time.Since(a.startedAt).Seconds()),
		"load":       ops.ReadLoad(),
		"mem":        ops.ReadMem(),
		"disk":       ops.ReadDisk(filepath.Clean(a.opts.DataDir)),
		"dns":        a.dns.Stats(),
		"mdns":       a.mdns.Counters(),
		"goroutines": runtime.NumGoroutine(),
	})
}

// flushDNS ships buffered query-log entries in batches of up to 500 while
// the link accepts them; anything not accepted goes back to the buffer.
func (a *Agent) flushDNS() {
	l := a.link.Load()
	if l == nil || !l.Up() {
		return
	}
	q := a.dns.QueryLog()
	for {
		batch := q.Drain(dnsd.QueryLogBatch)
		if len(batch) == 0 {
			return
		}
		if rest, ok := a.sendDNSBatch(batch); !ok {
			q.Requeue(rest)
			return
		}
	}
}

// sendDNSBatch sends entries, splitting batches that would exceed the
// frame limit. On failure it returns the unsent entries.
func (a *Agent) sendDNSBatch(entries []dnsd.LogEntry) ([]dnsd.LogEntry, bool) {
	data := map[string]any{"entries": entries}
	if len(entries) > 1 && proto.FrameSize(proto.Evt{T: proto.TypeEvt, Type: "dns.queries", Data: data}) > proto.FrameBudget {
		half := len(entries) / 2
		if rest, ok := a.sendDNSBatch(entries[:half]); !ok {
			return append(rest, entries[half:]...), false
		}
		return a.sendDNSBatch(entries[half:])
	}
	if !a.sendEvent("dns.queries", data) {
		return entries, false
	}
	return nil, true
}
