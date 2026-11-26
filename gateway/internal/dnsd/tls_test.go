package dnsd

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/miekg/dns"

	"github.com/astralwalker0o/screens/gateway/internal/netx"
)

func signCSR(t *testing.T, csrPEM string) string {
	t.Helper()
	blk, _ := pem.Decode([]byte(csrPEM))
	csr, err := x509.ParseCertificateRequest(blk.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := csr.CheckSignature(); err != nil {
		t.Fatal(err)
	}
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	caTpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Test CA"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDER, _ := x509.CreateCertificate(rand.Reader, caTpl, caTpl, &caKey.PublicKey, caKey)
	ca, _ := x509.ParseCertificate(caDER)
	leafTpl := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: csr.Subject, DNSNames: csr.DNSNames, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC), ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, KeyUsage: x509.KeyUsageDigitalSignature}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTpl, ca, csr.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER})) + string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}))
}

func TestCSRInstallAndDoT(t *testing.T) {
	up := newFakeUpstream(t)
	dir := t.TempDir()
	s := New(dir, nil, testLogger())
	defer s.Close()
	s.SetInterfaceSource(func() []netx.Iface { return nil })

	csr1, err := s.CSR("beach.dns.example")
	if err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(filepath.Join(dir, "tls", "dot.key"))
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("key mode %v %v", st, err)
	}
	blk, _ := pem.Decode([]byte(csr1))
	csr, _ := x509.ParseCertificateRequest(blk.Bytes)
	if csr.Subject.CommonName != "beach.dns.example" || len(csr.DNSNames) != 1 || csr.DNSNames[0] != "beach.dns.example" {
		t.Fatalf("csr %+v", csr.Subject)
	}
	if _, ok := csr.PublicKey.(*ecdsa.PublicKey); !ok {
		t.Fatal("not ECDSA")
	}
	// Reuses the key.
	csr2, _ := s.CSR("beach.dns.example")
	blk2, _ := pem.Decode([]byte(csr2))
	c2, _ := x509.ParseCertificateRequest(blk2.Bytes)
	if !c2.PublicKey.(*ecdsa.PublicKey).Equal(csr.PublicKey) {
		t.Fatal("key not reused")
	}

	// DoT enabled but no cert yet → not listening.
	cfg := mustCfg(t, `{"enabled":true,"listen":["127.0.0.1:0"],"upstreams":["`+up.srv.URL+`/dns-query"],"dot":{"enabled":true,"listen":["127.0.0.1:0"]}}`)
	stt := s.Apply(cfg)
	if len(stt.DoTListening) != 0 {
		t.Fatalf("dot listening without cert: %+v", stt)
	}

	// A cert for another key is rejected.
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(9), NotBefore: time.Now(), NotAfter: time.Now().Add(time.Hour)}
	der, _ := x509.CreateCertificate(rand.Reader, tpl, tpl, &other.PublicKey, other)
	if _, err := s.InstallCert(string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))); err == nil {
		t.Fatal("mismatched cert accepted")
	}

	notAfter, err := s.InstallCert(signCSR(t, csr1))
	if err != nil {
		t.Fatal(err)
	}
	if notAfter != time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("not_after %d", notAfter)
	}
	stt = s.Status()
	if len(stt.DoTListening) != 1 {
		t.Fatalf("dot not started: %+v", stt)
	}
	c := &dns.Client{Net: "tcp-tls", Timeout: 3 * time.Second, TLSConfig: &tls.Config{InsecureSkipVerify: true, ServerName: "beach.dns.example"}}
	m := new(dns.Msg)
	m.SetQuestion("dot.example.", dns.TypeA)
	r, _, err := c.Exchange(m, stt.DoTListening[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Answer) != 1 {
		t.Fatalf("dot answer %v", r)
	}
	if e := lastEntries(s)["dot.example/A"]; e.Proto != "dot" {
		t.Fatalf("dot entry %+v", e)
	}
}
