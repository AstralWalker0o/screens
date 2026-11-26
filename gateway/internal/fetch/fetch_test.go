package fetch

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/astralwalker0o/screens/gateway/internal/proto"
)

func TestCheckOrigin(t *testing.T) {
	c := New("https://screens.example.workers.dev")
	ok := []string{
		"https://screens.example.workers.dev/agent/v1/files/k?exp=1&sig=ab",
		"https://SCREENS.example.workers.dev:443/x",
	}
	bad := []string{
		"http://screens.example.workers.dev/x",
		"https://evil.example/agent/v1/files/k",
		"https://screens.example.workers.dev:8443/x",
		"ftp://screens.example.workers.dev/x",
		"not a url",
	}
	for _, u := range ok {
		if _, err := c.Check(u); err != nil {
			t.Errorf("%s: %v", u, err)
		}
	}
	for _, u := range bad {
		if _, err := c.Check(u); err == nil {
			t.Errorf("%s: accepted", u)
		}
	}
}

func TestDownloadAndPut(t *testing.T) {
	payload := []byte("hello policy")
	sum := sha256.Sum256(payload)
	var put []byte
	var putCT string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			_, _ = w.Write(payload)
		case http.MethodPut:
			put, _ = io.ReadAll(r.Body)
			putCT = r.Header.Get("Content-Type")
		}
	}))
	defer srv.Close()
	c := New(srv.URL)
	dst := filepath.Join(t.TempDir(), "f")
	if _, err := c.Download(context.Background(), srv.URL+"/agent/v1/files/a", dst, hex.EncodeToString(sum[:]), 1<<20); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dst); string(b) != string(payload) {
		t.Fatal("content")
	}
	_, err := c.Download(context.Background(), srv.URL+"/x", dst, "00", 1<<20)
	var pe *proto.Error
	if !errors.As(err, &pe) || pe.Code != proto.CodeFailed {
		t.Fatalf("bad sha: %v", err)
	}
	if _, err := os.Stat(dst); !os.IsNotExist(err) {
		t.Fatal("file not removed on sha mismatch")
	}
	if _, err := c.Download(context.Background(), srv.URL+"/x", dst, "", 3); err == nil {
		t.Fatal("size cap not enforced")
	}
	if err := c.Put(context.Background(), srv.URL+"/agent/v1/upload/k", "image/jpeg", []byte{1, 2, 3}); err != nil {
		t.Fatal(err)
	}
	if len(put) != 3 || putCT != "image/jpeg" {
		t.Fatalf("put %v %q", put, putCT)
	}
}
