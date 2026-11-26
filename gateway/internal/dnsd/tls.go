package dnsd

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/astralwalker0o/screens/gateway/internal/config"
	"github.com/astralwalker0o/screens/gateway/internal/proto"
)

func (s *Server) tlsDir() string   { return filepath.Join(s.dataDir, "tls") }
func (s *Server) keyPath() string  { return filepath.Join(s.tlsDir(), "dot.key") }
func (s *Server) certPath() string { return filepath.Join(s.tlsDir(), "dot.crt") }

// loadCert (re)loads dot.crt + dot.key into the live certificate. It
// returns false if they are missing or do not match.
func (s *Server) loadCert() bool {
	c, err := tls.LoadX509KeyPair(s.certPath(), s.keyPath())
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			s.log.Warn("dot certificate unusable", "err", err)
		}
		s.cert.Store(nil)
		return false
	}
	s.cert.Store(&c)
	return true
}

func (s *Server) loadOrCreateKey() (*ecdsa.PrivateKey, error) {
	if b, err := os.ReadFile(s.keyPath()); err == nil {
		blk, _ := pem.Decode(b)
		if blk == nil {
			return nil, errors.New("dot.key is not PEM")
		}
		if k, err := x509.ParseECPrivateKey(blk.Bytes); err == nil {
			return k, nil
		}
		k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
		if err != nil {
			return nil, fmt.Errorf("dot.key: %w", err)
		}
		ek, ok := k.(*ecdsa.PrivateKey)
		if !ok {
			return nil, errors.New("dot.key is not an ECDSA key")
		}
		return ek, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalECPrivateKey(k)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(s.tlsDir(), 0o700); err != nil {
		return nil, err
	}
	if err := config.WriteFileAtomic(s.keyPath(), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		return nil, err
	}
	return k, nil
}

// CSR implements tls.csr: generates (or reuses) dot.key and returns a PEM
// CSR with CN and SAN = hostname.
func (s *Server) CSR(hostname string) (string, error) {
	hostname = strings.TrimSuffix(strings.TrimSpace(hostname), ".")
	if hostname == "" || strings.ContainsAny(hostname, " /\\") {
		return "", proto.Errf(proto.CodeBadArgs, "invalid hostname %q", hostname)
	}
	k, err := s.loadOrCreateKey()
	if err != nil {
		return "", err
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject:  pkix.Name{CommonName: hostname},
		DNSNames: []string{hostname},
	}, k)
	if err != nil {
		return "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der})), nil
}

// InstallCert implements tls.install: validates the chain against dot.key,
// writes dot.crt and (re)starts the DoT listeners. It returns the leaf
// NotAfter in epoch ms.
func (s *Server) InstallCert(certPEM string) (int64, error) {
	keyPEM, err := os.ReadFile(s.keyPath())
	if err != nil {
		return 0, proto.Errf(proto.CodeFailed, "no dot.key; call tls.csr first")
	}
	pair, err := tls.X509KeyPair([]byte(certPEM), keyPEM)
	if err != nil {
		return 0, proto.Errf(proto.CodeBadArgs, "certificate does not match dot.key: %v", err)
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return 0, proto.Errf(proto.CodeBadArgs, "parse certificate: %v", err)
	}
	if err := config.WriteFileAtomic(s.certPath(), []byte(certPEM), 0o644); err != nil {
		return 0, err
	}
	s.applyMu.Lock()
	s.loadCert()
	s.reconcile()
	s.applyMu.Unlock()
	return leaf.NotAfter.UnixMilli(), nil
}
