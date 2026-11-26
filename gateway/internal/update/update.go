// Package update implements the binary swap behind sys.update
// (PROTOCOL.md §5 System): download to $DATA/bin/screens-gateway.new.part,
// verify sha256 and that it is an executable for this architecture,
// chmod 755, rename to screens-gateway.new and then over
// $DATA/bin/screens-gateway. The caller replies and exits 0 so Docker
// restarts on the new binary. A screens-gateway.new file therefore only
// ever holds a verified binary, so an entrypoint that installs a leftover
// .new on start is safe.
package update

import (
	"context"
	"debug/elf"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"

	"github.com/astralwalker0o/screens/gateway/internal/fetch"
	"github.com/astralwalker0o/screens/gateway/internal/proto"
)

// MaxBinary caps the download size.
const MaxBinary = 256 << 20

var shaRe = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

// BinPath is the binary location inside the data dir.
func BinPath(dataDir string) string { return filepath.Join(dataDir, "bin", "screens-gateway") }

func wantMachine() elf.Machine {
	switch runtime.GOARCH {
	case "amd64":
		return elf.EM_X86_64
	case "arm64":
		return elf.EM_AARCH64
	case "arm":
		return elf.EM_ARM
	case "386":
		return elf.EM_386
	}
	return elf.EM_NONE
}

// CheckELF verifies path is an ELF executable for this OS/arch.
func CheckELF(path string) error {
	f, err := elf.Open(path)
	if err != nil {
		return fmt.Errorf("not an ELF binary: %w", err)
	}
	defer f.Close()
	if m := wantMachine(); m != elf.EM_NONE && f.Machine != m {
		return fmt.Errorf("binary is for %v, this gateway is %s", f.Machine, runtime.GOARCH)
	}
	if f.Type != elf.ET_EXEC && f.Type != elf.ET_DYN {
		return fmt.Errorf("ELF type %v is not executable", f.Type)
	}
	return nil
}

// Apply downloads, verifies and installs a new binary.
func Apply(ctx context.Context, f *fetch.Client, dataDir, url, sha string) error {
	if !shaRe.MatchString(sha) {
		return proto.Errf(proto.CodeBadArgs, "sha256 must be 64 hex characters")
	}
	if url == "" {
		return proto.Errf(proto.CodeBadArgs, "url required")
	}
	dst := BinPath(dataDir)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	part := dst + ".new.part"
	staged := dst + ".new"
	if _, err := f.Download(ctx, url, part, sha, MaxBinary); err != nil {
		return err
	}
	if err := CheckELF(part); err != nil {
		os.Remove(part)
		return proto.Errf(proto.CodeFailed, "%v", err)
	}
	if err := os.Chmod(part, 0o755); err != nil {
		os.Remove(part)
		return err
	}
	if err := os.Rename(part, staged); err != nil {
		os.Remove(part)
		return err
	}
	if err := os.Rename(staged, dst); err != nil {
		os.Remove(staged)
		return err
	}
	return nil
}
