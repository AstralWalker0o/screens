package dnsd

import (
	"encoding/json"
	"fmt"
	"net/netip"
	"regexp"
	"strings"
)

// Modes (PROTOCOL.md §5 DNS).
const (
	ModeEnforce = "enforce"
	ModeMonitor = "monitor"
	ModeOff     = "off"
	ModeBypass  = "bypass"
)

// Config is the dns.configure argument object.
type Config struct {
	Enabled       bool                    `json:"enabled"`
	Listen        []string                `json:"listen"`
	DoT           DoTConfig               `json:"dot"`
	Upstreams     []string                `json:"upstreams"`
	BlockResponse string                  `json:"block_response"`
	Cache         CacheConfig             `json:"cache"`
	Default       ClientConfig            `json:"default"`
	Clients       map[string]ClientConfig `json:"clients"`
	Policies      map[string]PolicyRef    `json:"policies"`
	Log           LogConfig               `json:"log"`

	// Warnings lists entries that were ignored or replaced while parsing.
	Warnings []string `json:"-"`
}

// DoTConfig configures the DNS-over-TLS listener.
type DoTConfig struct {
	Enabled  bool     `json:"enabled"`
	Listen   []string `json:"listen"`
	Hostname string   `json:"hostname"`
}

// CacheConfig configures the response cache.
type CacheConfig struct {
	Enabled    bool `json:"enabled"`
	MaxEntries int  `json:"max_entries"`
	MinTTL     int  `json:"min_ttl_s"`
	MaxTTL     int  `json:"max_ttl_s"`
}

// ClientConfig is the per-client (or default) filtering setting.
type ClientConfig struct {
	DeviceID string   `json:"device_id,omitempty"`
	Policy   string   `json:"policy"`
	Mode     string   `json:"mode"`
	Allow    []string `json:"allow,omitempty"`
	Block    []string `json:"block,omitempty"`
}

// PolicyRef names a downloadable policy file.
type PolicyRef struct {
	Version string `json:"version"`
	URL     string `json:"url"`
	SHA256  string `json:"sha256"`
}

// LogConfig configures query logging.
type LogConfig struct {
	Enabled bool `json:"enabled"`
}

// DefaultUpstreams is used when the config lists none.
var DefaultUpstreams = []string{"https://1.1.1.1/dns-query", "https://1.0.0.1/dns-query"}

// DefaultConfig returns the values used for fields the hub omits. Note
// that "enabled" defaults to false: DNS only binds when explicitly enabled.
func DefaultConfig() Config {
	return Config{
		Enabled:       false,
		Listen:        []string{"0.0.0.0:53"},
		DoT:           DoTConfig{Listen: []string{"0.0.0.0:853"}},
		BlockResponse: "null",
		Cache:         CacheConfig{Enabled: true, MaxEntries: 20000, MinTTL: 0, MaxTTL: 86400},
		Default:       ClientConfig{Mode: ModeMonitor},
		Log:           LogConfig{Enabled: true},
	}
}

var policyNameRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)

// ParseConfig decodes dns.configure args on top of DefaultConfig. Only
// malformed JSON is an error: a bad entry (unknown mode, non-IP client key,
// unsafe policy name, unknown block_response) is replaced by a safe value
// and reported in Warnings, so one bad record never takes DNS down.
func ParseConfig(raw json.RawMessage) (Config, error) {
	cfg := DefaultConfig()
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &cfg); err != nil {
			return cfg, fmt.Errorf("dns config: %w", err)
		}
	}
	warn := func(format string, a ...any) { cfg.Warnings = append(cfg.Warnings, fmt.Sprintf(format, a...)) }
	if len(cfg.Upstreams) == 0 {
		cfg.Upstreams = DefaultUpstreams
	}
	switch cfg.BlockResponse {
	case "", "null":
		cfg.BlockResponse = "null"
	case "nxdomain":
	default:
		warn("block_response %q unknown; using null", cfg.BlockResponse)
		cfg.BlockResponse = "null"
	}
	if cfg.Cache.MaxEntries <= 0 {
		cfg.Cache.MaxEntries = 20000
	}
	if cfg.Cache.MaxTTL <= 0 {
		cfg.Cache.MaxTTL = 86400
	}
	if cfg.Cache.MinTTL < 0 {
		cfg.Cache.MinTTL = 0
	}
	if cfg.Cache.MinTTL > cfg.Cache.MaxTTL {
		cfg.Cache.MinTTL = cfg.Cache.MaxTTL
	}
	if cfg.Default.Mode == "" {
		cfg.Default.Mode = ModeMonitor
	}
	if err := validMode(cfg.Default.Mode); err != nil {
		warn("default: %v; using monitor", err)
		cfg.Default.Mode = ModeMonitor
	}
	for name := range cfg.Policies {
		if !policyNameRe.MatchString(name) {
			warn("policy name %q is not a safe identifier; ignored", name)
			delete(cfg.Policies, name)
		}
	}
	for ip, c := range cfg.Clients {
		if _, err := netip.ParseAddr(ip); err != nil {
			warn("clients: key %q is not an IP address; ignored", ip)
			delete(cfg.Clients, ip)
			continue
		}
		if c.Mode == "" {
			c.Mode = cfg.Default.Mode
		} else if err := validMode(c.Mode); err != nil {
			warn("client %s: %v; using %s", ip, err, cfg.Default.Mode)
			c.Mode = cfg.Default.Mode
		}
		cfg.Clients[ip] = c
	}
	return cfg, nil
}

func validMode(m string) error {
	switch m {
	case ModeEnforce, ModeMonitor, ModeOff, ModeBypass:
		return nil
	}
	return fmt.Errorf("invalid mode %q", m)
}

// NormalizeDomain lower-cases, trims dots and a leading "*.".
func NormalizeDomain(d string) string {
	d = strings.TrimSpace(d)
	d = strings.TrimPrefix(d, "*.")
	d = strings.Trim(d, ".")
	return toLowerASCII(d)
}

func toLowerASCII(s string) string {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if 'A' <= c && c <= 'Z' {
			b := []byte(s)
			for j := i; j < len(b); j++ {
				if 'A' <= b[j] && b[j] <= 'Z' {
					b[j] += 'a' - 'A'
				}
			}
			return string(b)
		}
	}
	return s
}
