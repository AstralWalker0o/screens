// Package config reads the agent's environment and persists the last applied
// hub configuration to $DATA/config.json so DNS and mDNS can start before
// (or without) the link to the cloud.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/astralwalker0o/screens/gateway/internal/proto"
)

// Env is the process configuration taken from environment variables.
type Env struct {
	CentralURL  string
	EnrollToken string
	DataDir     string
	LogLevel    string
}

// FromEnv reads SCREENS_* variables.
func FromEnv() Env {
	e := Env{
		CentralURL:  strings.TrimRight(strings.TrimSpace(os.Getenv("SCREENS_CENTRAL_URL")), "/"),
		EnrollToken: strings.TrimSpace(os.Getenv("SCREENS_ENROLL_TOKEN")),
		DataDir:     strings.TrimSpace(os.Getenv("SCREENS_DATA")),
		LogLevel:    strings.TrimSpace(os.Getenv("SCREENS_LOG_LEVEL")),
	}
	if e.DataDir == "" {
		e.DataDir = "/data"
	}
	if e.LogLevel == "" {
		e.LogLevel = "info"
	}
	return e
}

// Persisted is the content of $DATA/config.json.
type Persisted struct {
	DNS       json.RawMessage  `json:"dns,omitempty"`
	MDNS      json.RawMessage  `json:"mdns,omitempty"`
	Telemetry *proto.Telemetry `json:"telemetry,omitempty"`
}

// Store reads and writes config.json atomically.
type Store struct {
	path string
	mu   sync.Mutex
	cur  Persisted
}

// NewStore loads (or initialises) the store at dir/config.json.
func NewStore(dir string) (*Store, error) {
	s := &Store{path: filepath.Join(dir, "config.json")}
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(b, &s.cur); err != nil {
		return s, fmt.Errorf("parse %s: %w", s.path, err)
	}
	return s, nil
}

// Get returns a copy of the persisted config.
func (s *Store) Get() Persisted {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cur
}

// Update applies fn to the config and writes it out.
func (s *Store) Update(fn func(p *Persisted)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.cur
	fn(&next)
	b, err := json.Marshal(next)
	if err != nil {
		return err
	}
	if err := WriteFileAtomic(s.path, b, 0o600); err != nil {
		return err
	}
	s.cur = next
	return nil
}

// WriteFileAtomic writes data to a temp file in the same directory and
// renames it over path.
func WriteFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Chmod(perm); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
