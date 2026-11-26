package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/astralwalker0o/screens/gateway/internal/netx"
	"github.com/astralwalker0o/screens/gateway/internal/ops"
	"github.com/astralwalker0o/screens/gateway/internal/update"
)

func (a *Agent) registerOps() {
	r := a.reg
	r.Register("sys.info", a.opSysInfo)
	r.Register("sys.update", a.opSysUpdate)
	r.Register("sys.restart", a.opSysRestart)
	r.Register("sys.logs", a.opSysLogs)

	r.Register("dns.configure", func(ctx context.Context, raw json.RawMessage) (any, error) {
		return a.applyDNS(raw, true)
	})
	r.Register("dns.stats", func(ctx context.Context, raw json.RawMessage) (any, error) {
		return a.dns.Stats(), nil
	})
	r.Register("dns.flush_cache", func(ctx context.Context, raw json.RawMessage) (any, error) {
		a.dns.FlushCache()
		return map[string]any{}, nil
	})
	r.Register("tls.csr", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var args struct {
			Hostname string `json:"hostname"`
		}
		if err := ops.Decode(raw, &args); err != nil {
			return nil, err
		}
		pem, err := a.dns.CSR(args.Hostname)
		if err != nil {
			return nil, err
		}
		return map[string]any{"csr_pem": pem}, nil
	})
	r.Register("tls.install", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var args struct {
			CertPEM string `json:"cert_pem"`
		}
		if err := ops.Decode(raw, &args); err != nil {
			return nil, err
		}
		if strings.TrimSpace(args.CertPEM) == "" {
			return nil, ops.BadArgs("cert_pem required")
		}
		na, err := a.dns.InstallCert(args.CertPEM)
		if err != nil {
			return nil, err
		}
		return map[string]any{"not_after": na}, nil
	})

	r.Register("mdns.configure", func(ctx context.Context, raw json.RawMessage) (any, error) {
		return a.applyMDNS(raw, true)
	})
	r.Register("mdns.status", func(ctx context.Context, raw json.RawMessage) (any, error) {
		return a.mdns.Status(), nil
	})

	a.relay.Register(r)
	a.adb.Register(r)
	a.disc.Register(r)
}

func (a *Agent) opSysInfo(ctx context.Context, _ json.RawMessage) (any, error) {
	return map[string]any{
		"hostname":      a.hostname(),
		"version":       a.opts.Version,
		"uptime_s":      int64(time.Since(a.startedAt).Seconds()),
		"host_uptime_s": ops.HostUptime(),
		"started_at":    a.startedAt.UnixMilli(),
		"load":          ops.ReadLoad(),
		"mem":           ops.ReadMem(),
		"disk":          ops.ReadDisk(a.opts.DataDir),
		"interfaces":    netx.Describe(),
		"go_version":    runtime.Version(),
		"os":            runtime.GOOS,
		"arch":          runtime.GOARCH,
		"adb_version":   a.adb.Version(ctx),
		"caps":          a.caps(),
	}, nil
}

func (a *Agent) opSysUpdate(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		Version string `json:"version"`
		URL     string `json:"url"`
		SHA256  string `json:"sha256"`
	}
	if err := ops.Decode(raw, &args); err != nil {
		return nil, err
	}
	if exe, err := os.Executable(); err == nil {
		running, _ := filepath.EvalSymlinks(exe)
		target, _ := filepath.EvalSymlinks(update.BinPath(a.opts.DataDir))
		if running != target {
			a.log.Warn("running binary is not $DATA/bin/screens-gateway; the update takes effect only if the container runs that path", "exe", exe)
		}
	}
	start := time.Now()
	if err := update.Apply(ctx, a.fetch, a.opts.DataDir, args.URL, args.SHA256); err != nil {
		return nil, err
	}
	a.log.Info("update installed; restarting", "from", a.opts.Version, "to", args.Version, "took", time.Since(start).Round(time.Millisecond))
	return ops.After{Data: map[string]any{}, Fn: func() { a.requestExit(0) }}, nil
}

func (a *Agent) opSysRestart(ctx context.Context, _ json.RawMessage) (any, error) {
	return ops.After{Data: map[string]any{}, Fn: func() { a.requestExit(0) }}, nil
}

func (a *Agent) opSysLogs(ctx context.Context, raw json.RawMessage) (any, error) {
	var args struct {
		Lines int `json:"lines"`
	}
	if err := ops.Decode(raw, &args); err != nil {
		return nil, err
	}
	if args.Lines <= 0 {
		args.Lines = 200
	}
	if a.opts.Ring == nil {
		return map[string]any{"lines": []string{}}, nil
	}
	lines := a.opts.Ring.Last(args.Lines)
	data, _ := ops.FitFrame(len(lines), func(limit int) any {
		return map[string]any{"lines": lines[len(lines)-min(limit, len(lines)):]}
	})
	return data, nil
}
