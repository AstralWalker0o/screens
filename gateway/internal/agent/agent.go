// Package agent wires the gateway together: persisted config, DNS and mDNS
// (started first, from the last applied config, so the site keeps resolving
// without the cloud), enrollment, the hub link, the op registry and the
// telemetry loops.
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/astralwalker0o/screens/gateway/internal/adb"
	"github.com/astralwalker0o/screens/gateway/internal/config"
	"github.com/astralwalker0o/screens/gateway/internal/discovery"
	"github.com/astralwalker0o/screens/gateway/internal/dnsd"
	"github.com/astralwalker0o/screens/gateway/internal/fetch"
	"github.com/astralwalker0o/screens/gateway/internal/identity"
	"github.com/astralwalker0o/screens/gateway/internal/link"
	"github.com/astralwalker0o/screens/gateway/internal/logbuf"
	"github.com/astralwalker0o/screens/gateway/internal/mdns"
	"github.com/astralwalker0o/screens/gateway/internal/netx"
	"github.com/astralwalker0o/screens/gateway/internal/ops"
	"github.com/astralwalker0o/screens/gateway/internal/proto"
	"github.com/astralwalker0o/screens/gateway/internal/relay"
)

// Options configure the agent.
type Options struct {
	CentralURL  string
	EnrollToken string
	DataDir     string
	Version     string

	Logger  *slog.Logger
	Handler *logbuf.Handler // receives the warn+ hook; may be nil
	Ring    *logbuf.Ring    // backs sys.logs; may be nil

	// Exit is called after a requested restart/update once the agent has
	// shut down (default os.Exit).
	Exit func(code int)
	// EnrollRetry is the wait after a rejected enrollment (default 60 s).
	EnrollRetry time.Duration
}

// Agent is a running gateway.
type Agent struct {
	opts      Options
	log       *slog.Logger
	startedAt time.Time

	store *config.Store
	fetch *fetch.Client
	own   *netx.OwnAddrs
	dns   *dnsd.Server
	mdns  *mdns.Reflector
	relay *relay.Manager
	adb   *adb.ADB
	disc  *discovery.Discovery
	reg   *ops.Registry
	link  atomic.Pointer[link.Link]

	telemetry   atomic.Pointer[proto.Telemetry]
	teleChanged chan struct{}
	linkUp      chan struct{}
	applyMu     sync.Mutex

	cancel   context.CancelFunc
	exitCode atomic.Int32
	exitReq  atomic.Bool
}

// New builds an agent. Nothing runs until Run.
func New(opts Options) *Agent {
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.Exit == nil {
		opts.Exit = os.Exit
	}
	if opts.EnrollRetry <= 0 {
		opts.EnrollRetry = 60 * time.Second
	}
	if opts.Version == "" {
		opts.Version = "dev"
	}
	a := &Agent{opts: opts, log: opts.Logger, startedAt: time.Now(), teleChanged: make(chan struct{}, 1), linkUp: make(chan struct{}, 1)}
	t := proto.Telemetry{}.WithDefaults()
	a.telemetry.Store(&t)
	return a
}

func (a *Agent) comp(name string) *slog.Logger { return a.log.With("comp", name) }

// Run starts every subsystem and blocks until ctx ends or a restart is
// requested.
func (a *Agent) Run(parent context.Context) error {
	ctx, cancel := context.WithCancel(parent)
	a.cancel = cancel
	defer cancel()
	data := a.opts.DataDir
	for _, d := range []string{data, filepath.Join(data, "bin"), filepath.Join(data, "dns"), filepath.Join(data, "adb")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	_ = os.MkdirAll(filepath.Join(data, "tls"), 0o700)
	os.Remove(filepath.Join(data, "bin", "screens-gateway.new"))

	store, err := config.NewStore(data)
	if err != nil {
		a.log.Error("persisted config unreadable; starting without it", "err", err)
	}
	a.store = store

	central := a.opts.CentralURL
	if central == "" {
		if id, err := identity.Load(data); err == nil {
			central = id.CentralURL
		}
	}
	a.fetch = fetch.New(central)
	a.own = netx.NewOwnAddrs()
	a.dns = dnsd.New(data, a.fetch, a.comp("dns"))
	a.mdns = mdns.New(a.comp("mdns"), a.own)
	a.relay = relay.NewManager(a.comp("relay"))
	a.adb = adb.New(data, a.fetch, a.comp("adb"))
	a.disc = discovery.New(a.own)
	a.reg = ops.New()
	a.registerOps()

	// DNS and mDNS first, from the last persisted config.
	p := store.Get()
	if p.Telemetry != nil {
		t := p.Telemetry.WithDefaults()
		a.telemetry.Store(&t)
	}
	if len(p.DNS) > 0 {
		if _, err := a.applyDNS(p.DNS, false); err != nil {
			a.log.Error("persisted dns config rejected", "err", err)
		}
	}
	if len(p.MDNS) > 0 {
		if _, err := a.applyMDNS(p.MDNS, false); err != nil {
			a.log.Error("persisted mdns config rejected", "err", err)
		}
	}
	if !a.adb.Available() {
		a.log.Warn("adb not found; adb.* ops will return not_supported")
	}

	if a.opts.Handler != nil {
		a.opts.Handler.SetHook(func(level slog.Level, msg string, ts time.Time) {
			if l := a.link.Load(); l != nil {
				l.SendEvent("log", map[string]any{"level": logbuf.LevelName(level), "msg": msg, "ts": ts.UnixMilli()})
			}
		})
		defer a.opts.Handler.SetHook(nil)
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); a.telemetryLoop(ctx) }()
	go func() { defer wg.Done(); a.linkLoop(ctx) }()

	<-ctx.Done()
	wg.Wait()
	a.relay.Close()
	a.mdns.Close()
	a.dns.Close()
	a.log.Info("agent stopped")
	if a.exitReq.Load() {
		a.opts.Exit(int(a.exitCode.Load()))
	}
	return nil
}

// requestExit shuts the agent down and then calls Options.Exit. A watchdog
// forces the exit if shutdown hangs.
func (a *Agent) requestExit(code int) {
	if !a.exitReq.CompareAndSwap(false, true) {
		return
	}
	a.exitCode.Store(int32(code))
	a.log.Info("exiting for restart", "code", code)
	go func() {
		time.Sleep(10 * time.Second)
		a.opts.Exit(code)
	}()
	if a.cancel != nil {
		a.cancel()
	}
}

func (a *Agent) hostname() string {
	h, _ := os.Hostname()
	return h
}

func (a *Agent) loadIdentity(ctx context.Context) (*identity.Identity, error) {
	backoff := 2 * time.Second
	wait := func(d time.Duration) bool {
		select {
		case <-ctx.Done():
			return false
		case <-time.After(d):
			return true
		}
	}
	for {
		id, err := identity.Load(a.opts.DataDir)
		if err == nil {
			return id, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			a.log.Error("identity.json unreadable; not re-enrolling automatically", "err", err)
			if !wait(a.opts.EnrollRetry) {
				return nil, ctx.Err()
			}
			continue
		}
		if a.opts.CentralURL == "" || a.opts.EnrollToken == "" {
			a.log.Error("not enrolled: set SCREENS_CENTRAL_URL and SCREENS_ENROLL_TOKEN")
			if !wait(a.opts.EnrollRetry) {
				return nil, ctx.Err()
			}
			continue
		}
		hc := &http.Client{Transport: fetch.NewCloudTransport(), Timeout: 30 * time.Second}
		id, err = identity.Enroll(ctx, hc, a.opts.DataDir, a.opts.CentralURL, identity.EnrollRequest{
			Token: a.opts.EnrollToken, Hostname: a.hostname(), Version: a.opts.Version, OS: runtime.GOOS, Arch: runtime.GOARCH,
		})
		if err == nil {
			a.log.Info("enrolled", "site_id", id.SiteID, "site_name", id.SiteName, "gateway_id", id.GatewayID)
			return id, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		var ee *identity.EnrollError
		if errors.As(err, &ee) {
			if ee.Gone() {
				a.log.Error("enrollment token used or expired; issue a new token and restart the container", "status", ee.Status, "msg", ee.Message)
			} else {
				a.log.Error("enrollment rejected", "status", ee.Status, "code", ee.Code, "msg", ee.Message)
			}
			if !wait(a.opts.EnrollRetry) {
				return nil, ctx.Err()
			}
			continue
		}
		a.log.Warn("enrollment failed; retrying", "err", err, "wait", backoff)
		if !wait(backoff) {
			return nil, ctx.Err()
		}
		backoff *= 2
		if backoff > a.opts.EnrollRetry {
			backoff = a.opts.EnrollRetry
		}
	}
}

func (a *Agent) linkLoop(ctx context.Context) {
	id, err := a.loadIdentity(ctx)
	if err != nil {
		return
	}
	central := a.opts.CentralURL
	if central == "" {
		central = id.CentralURL
	} else if id.CentralURL != "" && id.CentralURL != central {
		a.log.Warn("SCREENS_CENTRAL_URL differs from the enrolled central_url; using the environment value", "env", central, "identity", id.CentralURL)
	}
	a.fetch.SetOrigin(central)
	l := link.New(link.Options{
		CentralURL: central,
		Identity:   id,
		Logger:     a.comp("link"),
		Registry:   a.reg,
		Streams:    a.relay,
		Hello:      a.hello,
		OnWelcome:  a.onWelcome,
		OnUp: func(*link.Session) {
			select {
			case a.linkUp <- struct{}{}:
			default:
			}
		},
		Workers:    32,
		HTTPClient: &http.Client{Transport: fetch.NewCloudTransportHTTP1()},
	})
	a.link.Store(l)
	l.Run(ctx)
}

func (a *Agent) caps() []string {
	c := []string{"dns", "dot", "mdns", "ssdp", "discovery", "wol", "http", "ws", "tcp", "update"}
	if a.adb.Available() {
		c = append([]string{"adb"}, c...)
	}
	return c
}

func (a *Agent) hello() any {
	st := a.dns.Status()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return proto.Hello{
		T:          proto.TypeHello,
		Version:    a.opts.Version,
		Hostname:   a.hostname(),
		OS:         runtime.GOOS,
		Arch:       runtime.GOARCH,
		StartedAt:  a.startedAt.UnixMilli(),
		Interfaces: netx.Describe(),
		Caps:       a.caps(),
		DNS:        proto.HelloDNS{Listening: st.Listening, DoTListening: st.DoTListening, PolicyVersions: st.PolicyVersions},
		ADBVersion: a.adb.Version(ctx),
	}
}

func (a *Agent) onWelcome(w proto.Welcome) {
	a.log.Info("welcome", "site_id", w.SiteID)
	if len(w.Config.DNS) > 0 && string(w.Config.DNS) != "null" {
		if _, err := a.applyDNS(w.Config.DNS, true); err != nil {
			a.log.Error("welcome dns config rejected", "err", err)
		}
	}
	if len(w.Config.MDNS) > 0 && string(w.Config.MDNS) != "null" {
		if _, err := a.applyMDNS(w.Config.MDNS, true); err != nil {
			a.log.Error("welcome mdns config rejected", "err", err)
		}
	}
	if w.Config.Telemetry != nil {
		t := w.Config.Telemetry.WithDefaults()
		a.telemetry.Store(&t)
		if a.store != nil {
			_ = a.store.Update(func(p *config.Persisted) { p.Telemetry = &t })
		}
		select {
		case a.teleChanged <- struct{}{}:
		default:
		}
	}
}

// applyDNS parses, applies and (optionally) persists a dns config.
func (a *Agent) applyDNS(raw json.RawMessage, persist bool) (dnsd.Status, error) {
	a.applyMu.Lock()
	defer a.applyMu.Unlock()
	cfg, err := dnsd.ParseConfig(raw)
	if err != nil {
		return dnsd.Status{}, proto.Errf(proto.CodeBadArgs, "%v", err)
	}
	st := a.dns.Apply(cfg)
	if persist && a.store != nil {
		if err := a.store.Update(func(p *config.Persisted) { p.DNS = append(json.RawMessage(nil), raw...) }); err != nil {
			a.log.Error("persist dns config", "err", err)
		}
	}
	return st, nil
}

func (a *Agent) applyMDNS(raw json.RawMessage, persist bool) (mdns.Result, error) {
	a.applyMu.Lock()
	defer a.applyMu.Unlock()
	cfg, err := mdns.ParseConfig(raw)
	if err != nil {
		return mdns.Result{}, proto.Errf(proto.CodeBadArgs, "%v", err)
	}
	res := a.mdns.Apply(cfg)
	if persist && a.store != nil {
		if err := a.store.Update(func(p *config.Persisted) { p.MDNS = append(json.RawMessage(nil), raw...) }); err != nil {
			a.log.Error("persist mdns config", "err", err)
		}
	}
	return res, nil
}
