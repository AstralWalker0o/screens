package dnsd

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/astralwalker0o/screens/gateway/internal/fetch"
)

type loadedPolicy struct {
	version string
	m       *Matcher
}

// PolicySet holds compiled policies, keeps $DATA/dns/<name>.gz in sync with
// the configured versions and downloads new versions in the background.
// While a new version downloads the previous one keeps serving.
type PolicySet struct {
	dir   string
	fetch *fetch.Client
	log   *slog.Logger

	mu      sync.RWMutex
	loaded  map[string]*loadedPolicy
	pending map[string]pendingFetch
	wg      sync.WaitGroup

	// RetryBase is the first retry delay after a failed download.
	RetryBase time.Duration
}

type pendingFetch struct {
	version string
	cancel  context.CancelFunc
}

// NewPolicySet creates a set caching files in dir.
func NewPolicySet(dir string, f *fetch.Client, log *slog.Logger) *PolicySet {
	return &PolicySet{dir: dir, fetch: f, log: log, loaded: map[string]*loadedPolicy{}, pending: map[string]pendingFetch{}, RetryBase: 15 * time.Second}
}

// Get returns the compiled policy, or nil if it is not loaded.
func (p *PolicySet) Get(name string) *Matcher {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if lp := p.loaded[name]; lp != nil {
		return lp.m
	}
	return nil
}

// Versions returns name → loaded version.
func (p *PolicySet) Versions() map[string]string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	out := make(map[string]string, len(p.loaded))
	for k, v := range p.loaded {
		out[k] = v.version
	}
	return out
}

var hexRe = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

func expectedSHA(ref PolicyRef) string {
	if ref.SHA256 != "" {
		return strings.ToLower(ref.SHA256)
	}
	if hexRe.MatchString(ref.Version) {
		return strings.ToLower(ref.Version)
	}
	return ""
}

func fileSHA(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func (p *PolicySet) path(name string) string { return filepath.Join(p.dir, name+".gz") }

// Sync reconciles the set with the configured policies. Policies whose
// cached file already matches are loaded synchronously (so DNS filters from
// the first query after boot); others download in the background.
func (p *PolicySet) Sync(refs map[string]PolicyRef) {
	_ = os.MkdirAll(p.dir, 0o755)
	p.mu.Lock()
	// Drop policies no longer referenced.
	for name := range p.loaded {
		if _, ok := refs[name]; !ok {
			delete(p.loaded, name)
			os.Remove(p.path(name))
		}
	}
	for name, pf := range p.pending {
		if ref, ok := refs[name]; !ok || ref.Version != pf.version {
			pf.cancel()
			delete(p.pending, name)
		}
	}
	var todo []string
	for name, ref := range refs {
		if lp := p.loaded[name]; lp != nil && lp.version == ref.Version {
			continue
		}
		if _, busy := p.pending[name]; busy {
			continue
		}
		todo = append(todo, name)
	}
	p.mu.Unlock()

	for _, name := range todo {
		ref := refs[name]
		if p.loadCached(name, ref) {
			continue
		}
		ctx, cancel := context.WithCancel(context.Background())
		p.mu.Lock()
		p.pending[name] = pendingFetch{version: ref.Version, cancel: cancel}
		p.mu.Unlock()
		p.wg.Add(1)
		go p.download(ctx, name, ref)
	}
}

// loadCached loads $dir/<name>.gz if its hash matches ref.
func (p *PolicySet) loadCached(name string, ref PolicyRef) bool {
	path := p.path(name)
	if _, err := os.Stat(path); err != nil {
		return false
	}
	want := expectedSHA(ref)
	if want != "" {
		got, err := fileSHA(path)
		if err != nil || got != want {
			return false
		}
	}
	start := time.Now()
	m, err := LoadPolicyFile(path)
	if err != nil {
		p.log.Warn("cached policy unreadable", "policy", name, "err", err)
		return false
	}
	p.install(name, ref.Version, m)
	p.log.Info("policy loaded from cache", "policy", name, "rules", m.Rules(), "took", time.Since(start).Round(time.Millisecond))
	return true
}

func (p *PolicySet) install(name, version string, m *Matcher) {
	p.mu.Lock()
	p.loaded[name] = &loadedPolicy{version: version, m: m}
	p.mu.Unlock()
}

func (p *PolicySet) download(ctx context.Context, name string, ref PolicyRef) {
	defer p.wg.Done()
	defer func() {
		p.mu.Lock()
		if pf, ok := p.pending[name]; ok && pf.version == ref.Version {
			delete(p.pending, name)
		}
		p.mu.Unlock()
	}()
	delay := p.RetryBase
	for attempt := 1; ; attempt++ {
		err := p.fetchOnce(ctx, name, ref)
		if err == nil {
			return
		}
		if ctx.Err() != nil {
			return
		}
		lvl := slog.LevelWarn
		if attempt > 3 {
			lvl = slog.LevelDebug
		}
		p.log.Log(ctx, lvl, "policy download failed", "policy", name, "attempt", attempt, "retry_in", delay, "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		delay *= 2
		if delay > 10*time.Minute {
			delay = 10 * time.Minute
		}
	}
}

func (p *PolicySet) fetchOnce(ctx context.Context, name string, ref PolicyRef) error {
	if p.fetch == nil {
		return os.ErrInvalid
	}
	tmp := p.path(name) + ".part"
	dctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	start := time.Now()
	if _, err := p.fetch.Download(dctx, ref.URL, tmp, expectedSHA(ref), 256<<20); err != nil {
		return err
	}
	m, err := LoadPolicyFile(tmp)
	if err != nil {
		os.Remove(tmp)
		return err
	}
	p.mu.Lock()
	pf, still := p.pending[name]
	current := still && pf.version == ref.Version
	p.mu.Unlock()
	if !current || ctx.Err() != nil {
		os.Remove(tmp)
		return nil
	}
	if err := os.Rename(tmp, p.path(name)); err != nil {
		os.Remove(tmp)
		return err
	}
	p.install(name, ref.Version, m)
	p.log.Info("policy downloaded", "policy", name, "version", short(ref.Version), "rules", m.Rules(), "took", time.Since(start).Round(time.Millisecond))
	return nil
}

// Close cancels pending downloads.
func (p *PolicySet) Close() {
	p.mu.Lock()
	for name, pf := range p.pending {
		pf.cancel()
		delete(p.pending, name)
	}
	p.mu.Unlock()
	p.wg.Wait()
}

// WaitIdle blocks until no downloads are pending (tests).
func (p *PolicySet) WaitIdle(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		p.mu.RLock()
		n := len(p.pending)
		p.mu.RUnlock()
		if n == 0 {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

func short(v string) string {
	if len(v) > 12 {
		return v[:12]
	}
	return v
}
