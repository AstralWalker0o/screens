// Package dnsd is the site DNS resolver: per-client filtering with compiled
// policy files, a TTL-respecting cache, DoH upstreams with UDP fallback, DoT,
// query logging and stats (PROTOCOL.md §5 DNS). It runs from the last
// persisted config so the site keeps resolving with no link to the cloud.
package dnsd

import (
	"context"
	"crypto/tls"
	"log/slog"
	"net"
	"net/netip"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/miekg/dns"

	"github.com/astralwalker0o/screens/gateway/internal/fetch"
	"github.com/astralwalker0o/screens/gateway/internal/guard"
	"github.com/astralwalker0o/screens/gateway/internal/netx"
)

type client struct {
	deviceID string
	policy   string
	mode     string
	inline   *Matcher
}

type state struct {
	cfg     Config
	clients map[netip.Addr]*client
	def     *client
}

func compile(cfg Config) *state {
	st := &state{cfg: cfg, clients: map[netip.Addr]*client{}}
	st.def = &client{deviceID: cfg.Default.DeviceID, policy: cfg.Default.Policy, mode: cfg.Default.Mode, inline: InlineMatcher(cfg.Default.Allow, cfg.Default.Block)}
	for ip, c := range cfg.Clients {
		a, err := netip.ParseAddr(ip)
		if err != nil {
			continue
		}
		st.clients[a.Unmap().WithZone("")] = &client{deviceID: c.DeviceID, policy: c.Policy, mode: c.Mode, inline: InlineMatcher(c.Allow, c.Block)}
	}
	return st
}

func (st *state) client(a netip.Addr) *client {
	if c := st.clients[a.Unmap().WithZone("")]; c != nil {
		return c
	}
	return st.def
}

// Decision is the filtering outcome for one name.
type Decision struct {
	Block bool
	Rule  string
	Cat   string
}

// Decide applies inline rules, then the policy file. pol is nil when the
// client's policy is not loaded.
func Decide(inline, pol *Matcher, policyName, qname string) Decision {
	if inline != nil {
		switch v, _, _ := inline.Match(qname); v {
		case VerdictAllow:
			return Decision{Rule: "client_allow"}
		case VerdictBlock:
			return Decision{Block: true, Rule: "client_block"}
		}
	}
	if policyName == "" {
		return Decision{}
	}
	if pol == nil {
		return Decision{Rule: "policy_missing"}
	}
	v, rule, cat := pol.Match(qname)
	switch v {
	case VerdictBlock:
		return Decision{Block: true, Rule: rule, Cat: cat}
	case VerdictAllow:
		return Decision{Rule: rule, Cat: cat}
	}
	return Decision{}
}

// Status describes what the server is doing.
type Status struct {
	Enabled        bool              `json:"enabled"`
	Listening      []string          `json:"listening"`
	DoTListening   []string          `json:"dot_listening"`
	PolicyVersions map[string]string `json:"policy_versions"`
	Errors         []string          `json:"errors,omitempty"`
}

type listener struct {
	key   string
	bound string
	udp   *dns.Server
	tcp   *dns.Server
}

func (l *listener) shutdown() {
	if l.udp != nil {
		_ = l.udp.Shutdown()
	}
	if l.tcp != nil {
		_ = l.tcp.Shutdown()
	}
}

// Server is the resolver.
type Server struct {
	dataDir string
	log     *slog.Logger

	state    atomic.Pointer[state]
	cache    *Cache
	up       *Upstreams
	policies *PolicySet
	qlog     *QueryLog
	stats    *Stats

	applyMu   sync.Mutex
	mu        sync.Mutex
	listeners map[string]*listener
	dot       map[string]*listener
	bindWarn  map[string]bool
	cert      atomic.Pointer[tls.Certificate]
	ifaces    func() []netx.Iface
	local     *netx.LocalNets

	resync chan struct{}
	stop   chan struct{}
	wg     sync.WaitGroup
}

// New creates a server. Nothing listens until Apply is called.
func New(dataDir string, f *fetch.Client, log *slog.Logger) *Server {
	s := &Server{
		dataDir:   dataDir,
		log:       log,
		cache:     NewCache(20000, 0, 86400),
		up:        NewUpstreams(),
		policies:  NewPolicySet(filepath.Join(dataDir, "dns"), f, log),
		qlog:      NewQueryLog(QueryLogMax, QueryLogBatch),
		stats:     NewStats(),
		listeners: map[string]*listener{},
		dot:       map[string]*listener{},
		bindWarn:  map[string]bool{},
		ifaces:    func() []netx.Iface { all, _ := netx.List(); return all },
		local:     netx.NewLocalNets(),
		resync:    make(chan struct{}, 1),
		stop:      make(chan struct{}),
	}
	s.up.OnError = func() { s.stats.upstreamErrors.Add(1) }
	s.wg.Add(1)
	go s.resyncLoop()
	return s
}

// Upstreams exposes the upstream resolver (tests tune it).
func (s *Server) Upstreams() *Upstreams { return s.up }

// Policies exposes the policy set.
func (s *Server) Policies() *PolicySet { return s.policies }

// QueryLog returns the buffered query log.
func (s *Server) QueryLog() *QueryLog { return s.qlog }

// Stats returns dns.stats.
func (s *Server) Stats() StatsSnapshot { return s.stats.Snapshot() }

// FlushCache empties the cache.
func (s *Server) FlushCache() { s.cache.Flush() }

// Apply installs a new configuration. Listeners are reconciled (kept,
// started, stopped); bind failures are logged and reported in Status.Errors
// but do not stop the other listeners.
func (s *Server) Apply(cfg Config) Status {
	s.applyMu.Lock()
	defer s.applyMu.Unlock()
	errs := append([]string(nil), cfg.Warnings...)
	for _, w := range cfg.Warnings {
		s.log.Warn("dns config", "warning", w)
	}
	if bad := s.up.SetURLs(cfg.Upstreams); len(bad) > 0 {
		for _, b := range bad {
			errs = append(errs, "invalid upstream "+b)
		}
	}
	s.cache.Configure(cfg.Cache.MaxEntries, uint32(cfg.Cache.MinTTL), uint32(cfg.Cache.MaxTTL))
	if !cfg.Cache.Enabled {
		s.cache.Flush()
	}
	s.policies.Sync(cfg.Policies)
	s.state.Store(compile(cfg))
	errs = append(errs, s.reconcile()...)
	st := s.Status()
	st.Errors = errs
	return st
}

// Status returns the current listening state.
func (s *Server) Status() Status {
	st := Status{Listening: []string{}, DoTListening: []string{}, PolicyVersions: s.policies.Versions()}
	if cur := s.state.Load(); cur != nil {
		st.Enabled = cur.cfg.Enabled
	}
	s.mu.Lock()
	for _, l := range s.listeners {
		st.Listening = append(st.Listening, l.bound)
	}
	for _, l := range s.dot {
		st.DoTListening = append(st.DoTListening, l.bound)
	}
	s.mu.Unlock()
	sort.Strings(st.Listening)
	sort.Strings(st.DoTListening)
	return st
}

func (s *Server) resyncLoop() {
	defer s.wg.Done()
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-t.C:
		case <-s.resync:
		}
		s.applyMu.Lock()
		if s.state.Load() != nil {
			s.reconcile()
		}
		s.applyMu.Unlock()
	}
}

// reconcile brings the listener sets in line with the current state and
// interface addresses. Caller holds applyMu.
func (s *Server) reconcile() []string {
	st := s.state.Load()
	var want, wantDoT []string
	var errs []string
	ifaces := s.ifaces()
	if st != nil && st.cfg.Enabled {
		var bad []string
		want, bad = netx.ExpandListen(st.cfg.Listen, ifaces)
		for _, b := range bad {
			errs = append(errs, "invalid listen address "+b)
		}
		if st.cfg.DoT.Enabled {
			if s.loadCert() {
				wantDoT, bad = netx.ExpandListen(st.cfg.DoT.Listen, ifaces)
				for _, b := range bad {
					errs = append(errs, "invalid dot listen address "+b)
				}
			} else {
				errs = append(errs, "dot enabled but "+filepath.Join(s.dataDir, "tls", "dot.crt")+" / dot.key missing or invalid")
			}
		}
	}
	errs = append(errs, s.reconcileSet(s.listeners, want, false)...)
	errs = append(errs, s.reconcileSet(s.dot, wantDoT, true)...)
	return errs
}

func (s *Server) reconcileSet(set map[string]*listener, want []string, dot bool) []string {
	wantSet := map[string]bool{}
	for _, w := range want {
		wantSet[w] = true
	}
	s.mu.Lock()
	var stale []*listener
	for k, l := range set {
		if !wantSet[k] {
			stale = append(stale, l)
			delete(set, k)
		}
	}
	var todo []string
	for _, w := range want {
		if _, ok := set[w]; !ok {
			todo = append(todo, w)
		}
	}
	s.mu.Unlock()
	for _, l := range stale {
		l.shutdown()
		s.log.Info("dns listener stopped", "addr", l.bound, "dot", dot)
	}
	var errs []string
	for _, addr := range todo {
		l, err := s.start(addr, dot)
		warnKey := addr
		if dot {
			warnKey = "dot:" + addr
		}
		if err != nil {
			msg := "bind " + addr + ": " + err.Error()
			errs = append(errs, msg)
			s.mu.Lock()
			first := !s.bindWarn[warnKey]
			s.bindWarn[warnKey] = true
			s.mu.Unlock()
			if first {
				s.log.Warn("dns listener failed", "addr", addr, "dot", dot, "err", err)
			} else {
				s.log.Debug("dns listener still failing", "addr", addr, "dot", dot, "err", err)
			}
			continue
		}
		s.mu.Lock()
		delete(s.bindWarn, warnKey)
		set[addr] = l
		s.mu.Unlock()
		s.log.Info("dns listener started", "addr", l.bound, "dot", dot)
	}
	return errs
}

func (s *Server) start(addr string, dot bool) (*listener, error) {
	l := &listener{key: addr}
	if dot {
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			return nil, err
		}
		l.bound = ln.Addr().String()
		tl := tls.NewListener(ln, &tls.Config{
			MinVersion: tls.VersionTLS12,
			GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
				return s.cert.Load(), nil
			},
		})
		l.tcp = &dns.Server{Listener: tl, Net: "tcp-tls", Handler: s.handlerFor("dot"), IdleTimeout: func() time.Duration { return 30 * time.Second }}
		go func() { _ = l.tcp.ActivateAndServe() }()
		return l, nil
	}
	pc, err := net.ListenPacket("udp", addr)
	if err != nil {
		return nil, err
	}
	l.bound = pc.LocalAddr().String()
	l.udp = &dns.Server{PacketConn: pc, Handler: s.handlerFor("udp"), UDPSize: 4096}
	go func() { _ = l.udp.ActivateAndServe() }()
	if ln, err := net.Listen("tcp", l.bound); err == nil {
		l.tcp = &dns.Server{Listener: ln, Net: "tcp", Handler: s.handlerFor("tcp")}
		go func() { _ = l.tcp.ActivateAndServe() }()
	} else {
		s.log.Warn("dns tcp listener failed; udp only", "addr", l.bound, "err", err)
	}
	return l, nil
}

// Close stops all listeners and background work.
func (s *Server) Close() {
	close(s.stop)
	s.wg.Wait()
	s.mu.Lock()
	all := make([]*listener, 0, len(s.listeners)+len(s.dot))
	for k, l := range s.listeners {
		all = append(all, l)
		delete(s.listeners, k)
	}
	for k, l := range s.dot {
		all = append(all, l)
		delete(s.dot, k)
	}
	s.mu.Unlock()
	for _, l := range all {
		l.shutdown()
	}
	s.policies.Close()
}

// clientAllowed accepts private/loopback sources and anything on one of
// the host's own subnets (e.g. LAN clients with global IPv6 addresses).
func (s *Server) clientAllowed(a netip.Addr) bool {
	return guard.IsPrivateOrLoopback(a) || s.local.Contains(a)
}

func (s *Server) handlerFor(proto string) dns.Handler {
	return dns.HandlerFunc(func(w dns.ResponseWriter, r *dns.Msg) { s.serve(w, r, proto) })
}

func addrOf(a net.Addr) netip.Addr {
	switch v := a.(type) {
	case *net.UDPAddr:
		ip, _ := netip.AddrFromSlice(v.IP)
		return ip.Unmap()
	case *net.TCPAddr:
		ip, _ := netip.AddrFromSlice(v.IP)
		return ip.Unmap()
	}
	if a == nil {
		return netip.Addr{}
	}
	ap, err := netip.ParseAddrPort(a.String())
	if err != nil {
		return netip.Addr{}
	}
	return ap.Addr().Unmap()
}

func (s *Server) serve(w dns.ResponseWriter, req *dns.Msg, proto string) {
	start := time.Now()
	st := s.state.Load()
	cip := addrOf(w.RemoteAddr())
	if st == nil || !s.clientAllowed(cip) {
		// Never act as an open resolver for off-link public sources.
		m := new(dns.Msg)
		m.SetRcode(req, dns.RcodeRefused)
		_ = w.WriteMsg(m)
		return
	}
	if req.Opcode != dns.OpcodeQuery {
		m := new(dns.Msg)
		m.SetRcode(req, dns.RcodeNotImplemented)
		_ = w.WriteMsg(m)
		return
	}
	if len(req.Question) != 1 {
		m := new(dns.Msg)
		m.SetRcode(req, dns.RcodeFormatError)
		_ = w.WriteMsg(m)
		return
	}
	s.stats.query(start)
	q := req.Question[0]
	qname := toLowerASCII(strings.TrimSuffix(q.Name, "."))
	cl := st.client(cip)

	entry := LogEntry{
		Ts:       start.UnixMilli(),
		Client:   cip.String(),
		DeviceID: cl.deviceID,
		QName:    qname,
		QType:    typeString(q.Qtype),
		Action:   "allow",
		Proto:    proto,
	}

	var resp *dns.Msg
	if cl.mode == ModeEnforce || cl.mode == ModeMonitor {
		d := Decide(cl.inline, s.policies.Get(cl.policy), cl.policy, qname)
		entry.Rule, entry.Cat = d.Rule, d.Cat
		if d.Block {
			if cl.mode == ModeEnforce {
				entry.Action = "block"
				s.stats.blocked.Add(1)
				resp = blockResponse(req, st.cfg.BlockResponse == "nxdomain")
			} else {
				entry.Action = "would_block"
				s.stats.wouldBlock.Add(1)
			}
		}
	}
	if resp == nil {
		resp, entry.Cached = s.resolve(req, st)
	}
	if proto == "udp" {
		size := dns.MinMsgSize
		if opt := req.IsEdns0(); opt != nil && int(opt.UDPSize()) > size {
			size = int(opt.UDPSize())
		}
		resp.Truncate(size)
	}
	if cl.mode != ModeBypass && st.cfg.Log.Enabled {
		entry.RCode = rcodeString(resp.Rcode)
		entry.Answers = answers(resp)
		entry.Ms = time.Since(start).Milliseconds()
		s.qlog.Add(entry)
	}
	_ = w.WriteMsg(resp)
}

func (s *Server) resolve(req *dns.Msg, st *state) (*dns.Msg, bool) {
	now := time.Now()
	key := ""
	if st.cfg.Cache.Enabled {
		key = CacheKey(req)
		if m := s.cache.Get(key, now); m != nil {
			s.stats.cacheHits.Add(1)
			m.Id = req.Id
			m.Question = req.Question
			return m, true
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	q := req.Copy()
	resp, err := s.up.Exchange(ctx, q)
	if err != nil {
		s.log.Debug("dns upstream failure", "qname", req.Question[0].Name, "err", err)
		if key != "" {
			if m := s.cache.GetStale(key, time.Now()); m != nil {
				m.Id = req.Id
				m.Question = req.Question
				return m, true
			}
		}
		m := new(dns.Msg)
		m.SetRcode(req, dns.RcodeServerFailure)
		m.RecursionAvailable = true
		return m, false
	}
	resp.Id = req.Id
	resp.Question = req.Question
	if key != "" {
		s.cache.Put(key, resp, now)
	}
	return resp, false
}

func blockResponse(req *dns.Msg, nx bool) *dns.Msg {
	m := new(dns.Msg)
	m.SetReply(req)
	m.RecursionAvailable = true
	if opt := req.IsEdns0(); opt != nil {
		m.SetEdns0(opt.UDPSize(), false)
	}
	if nx {
		m.Rcode = dns.RcodeNameError
		return m
	}
	q := req.Question[0]
	hdr := dns.RR_Header{Name: q.Name, Rrtype: q.Qtype, Class: dns.ClassINET, Ttl: 60}
	switch q.Qtype {
	case dns.TypeA:
		m.Answer = []dns.RR{&dns.A{Hdr: hdr, A: net.IPv4zero.To4()}}
	case dns.TypeAAAA:
		m.Answer = []dns.RR{&dns.AAAA{Hdr: hdr, AAAA: net.IPv6zero}}
	}
	return m
}

func answers(m *dns.Msg) []string {
	out := []string{}
	for _, rr := range m.Answer {
		if len(out) == 8 {
			break
		}
		switch v := rr.(type) {
		case *dns.A:
			out = append(out, v.A.String())
		case *dns.AAAA:
			out = append(out, v.AAAA.String())
		case *dns.CNAME:
			out = append(out, strings.TrimSuffix(v.Target, "."))
		}
	}
	return out
}

func typeString(t uint16) string {
	if s, ok := dns.TypeToString[t]; ok {
		return s
	}
	return "TYPE" + strconv.Itoa(int(t))
}

func rcodeString(r int) string {
	if s, ok := dns.RcodeToString[r]; ok {
		return s
	}
	return "RCODE" + strconv.Itoa(r)
}

// SetInterfaceSource overrides interface enumeration (tests).
func (s *Server) SetInterfaceSource(fn func() []netx.Iface) { s.ifaces = fn }
