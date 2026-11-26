package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/astralwalker0o/screens/gateway/internal/fetch"
	"github.com/astralwalker0o/screens/gateway/internal/proto"
)

func TestApply(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	bin, err := os.ReadFile(self) // the test binary is an ELF for this arch
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(bin)
	sha := hex.EncodeToString(sum[:])
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/agent/v1/files/text" {
			_, _ = w.Write([]byte("#!/bin/sh\necho hi\n"))
			return
		}
		_, _ = w.Write(bin)
	}))
	defer srv.Close()
	f := fetch.New(srv.URL)
	dir := t.TempDir()
	dst := BinPath(dir)
	_ = os.MkdirAll(filepath.Dir(dst), 0o755)
	_ = os.WriteFile(dst, []byte("old"), 0o755)

	if err := Apply(context.Background(), f, dir, srv.URL+"/agent/v1/files/bin", sha); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(dst)
	if err != nil || st.Mode().Perm() != 0o755 || st.Size() != int64(len(bin)) {
		t.Fatalf("installed %v %v", st, err)
	}
	for _, leftover := range []string{dst + ".new", dst + ".new.part"} {
		if _, err := os.Stat(leftover); !os.IsNotExist(err) {
			t.Fatalf("%s left behind", leftover)
		}
	}

	var pe *proto.Error
	// Wrong hash leaves the current binary alone.
	err = Apply(context.Background(), f, dir, srv.URL+"/agent/v1/files/bin", hex.EncodeToString(make([]byte, 32)))
	if !errors.As(err, &pe) || pe.Code != proto.CodeFailed {
		t.Fatalf("bad sha: %v", err)
	}
	// Not an ELF.
	txt := []byte("#!/bin/sh\necho hi\n")
	ts := sha256.Sum256(txt)
	if err := Apply(context.Background(), f, dir, srv.URL+"/agent/v1/files/text", hex.EncodeToString(ts[:])); err == nil {
		t.Fatal("script accepted as binary")
	}
	if b, _ := os.ReadFile(dst); len(b) != len(bin) {
		t.Fatal("binary replaced by failed update")
	}
	// Off-origin URL.
	if err := Apply(context.Background(), f, dir, "https://evil.example/bin", sha); !errors.As(err, &pe) || pe.Code != proto.CodeForbidden {
		t.Fatalf("origin: %v", err)
	}
	if err := Apply(context.Background(), f, dir, srv.URL, "abc"); !errors.As(err, &pe) || pe.Code != proto.CodeBadArgs {
		t.Fatalf("sha format: %v", err)
	}
}
