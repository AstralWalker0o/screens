// Package adb implements the adb.* operations (PROTOCOL.md §5 ADB) by
// shelling out to the stock `adb` binary. Keys live in $DATA/adb. When adb
// is not installed every op returns not_supported.
package adb

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/astralwalker0o/screens/gateway/internal/fetch"
	"github.com/astralwalker0o/screens/gateway/internal/guard"
	"github.com/astralwalker0o/screens/gateway/internal/ops"
	"github.com/astralwalker0o/screens/gateway/internal/proto"
)

// Limits.
const (
	MaxShellStdout = 1 << 20
	maxStderr      = 64 << 10
	maxScreencap   = 64 << 20
	maxDownload    = 2 << 30
)

// ADB runs adb commands.
type ADB struct {
	dataDir string
	log     *slog.Logger
	fetch   *fetch.Client

	// Bin overrides the adb binary path (tests). Empty means $PATH lookup.
	Bin string

	mu      sync.Mutex
	started bool
}

// New creates an ADB runner.
func New(dataDir string, f *fetch.Client, log *slog.Logger) *ADB {
	return &ADB{dataDir: dataDir, fetch: f, log: log}
}

func (a *ADB) home() string { return filepath.Join(a.dataDir, "adb") }

// Path returns the adb binary, if any.
func (a *ADB) Path() (string, bool) {
	if a.Bin != "" {
		if _, err := os.Stat(a.Bin); err == nil {
			return a.Bin, true
		}
		return "", false
	}
	p, err := exec.LookPath("adb")
	return p, err == nil
}

// Available reports whether adb is installed.
func (a *ADB) Available() bool {
	_, ok := a.Path()
	return ok
}

type result struct {
	stdout    []byte
	stderr    []byte
	exit      int
	truncated bool
}

func (r result) combined() string {
	return strings.TrimSpace(string(r.stdout) + string(r.stderr))
}

// capWriter keeps the first n bytes and discards the rest.
type capWriter struct {
	buf       bytes.Buffer
	n         int
	truncated bool
}

func (w *capWriter) Write(p []byte) (int, error) {
	if room := w.n - w.buf.Len(); room > 0 {
		if len(p) > room {
			w.buf.Write(p[:room])
			w.truncated = true
		} else {
			w.buf.Write(p)
		}
	} else if len(p) > 0 {
		w.truncated = true
	}
	return len(p), nil
}

func (a *ADB) env() []string {
	home := a.home()
	env := []string{}
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "HOME=") || strings.HasPrefix(kv, "ANDROID_USER_HOME=") {
			continue
		}
		env = append(env, kv)
	}
	return append(env, "HOME="+home, "ANDROID_USER_HOME="+home)
}

func (a *ADB) exec(ctx context.Context, stdoutCap int, args ...string) (result, error) {
	bin, ok := a.Path()
	if !ok {
		return result{}, proto.Errf(proto.CodeNotSupported, "adb is not installed on this gateway")
	}
	_ = os.MkdirAll(a.home(), 0o700)
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = a.env()
	cmd.Dir = a.home()
	cmd.WaitDelay = 2 * time.Second
	out := &capWriter{n: stdoutCap}
	errw := &capWriter{n: maxStderr}
	cmd.Stdout, cmd.Stderr = out, errw
	err := cmd.Run()
	r := result{stdout: out.buf.Bytes(), stderr: errw.buf.Bytes(), truncated: out.truncated}
	if ctx.Err() != nil {
		return r, proto.Errf(proto.CodeTimeout, "adb %s: %v", strings.Join(redact(args), " "), ctx.Err())
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		r.exit = ee.ExitCode()
		return r, nil
	}
	if err != nil {
		return r, proto.Errf(proto.CodeFailed, "run adb: %v", err)
	}
	return r, nil
}

// redact hides pairing codes in log/error output.
func redact(args []string) []string {
	if len(args) >= 3 && args[0] == "pair" {
		c := append([]string{}, args...)
		c[2] = "******"
		return c
	}
	return args
}

// run starts the server lazily, then runs adb.
func (a *ADB) run(ctx context.Context, stdoutCap int, args ...string) (result, error) {
	if err := a.ensureServer(ctx); err != nil {
		return result{}, err
	}
	r, err := a.exec(ctx, stdoutCap, args...)
	if err == nil && r.exit != 0 && strings.Contains(string(r.stderr), "cannot connect to daemon") {
		a.mu.Lock()
		a.started = false
		a.mu.Unlock()
	}
	return r, err
}

func (a *ADB) ensureServer(ctx context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.started {
		return nil
	}
	sctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	r, err := a.exec(sctx, 64<<10, "start-server")
	if err != nil {
		return err
	}
	if r.exit != 0 {
		return proto.Errf(proto.CodeFailed, "adb start-server: %s", r.combined())
	}
	a.started = true
	return nil
}

var versionRe = regexp.MustCompile(`Android Debug Bridge version ([0-9.]+)`)

// Version returns the adb protocol version ("1.0.41") or "".
func (a *ADB) Version(ctx context.Context) string {
	if !a.Available() {
		return ""
	}
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	r, err := a.exec(cctx, 4096, "version")
	if err != nil {
		return ""
	}
	if m := versionRe.FindSubmatch(r.stdout); m != nil {
		return string(m[1])
	}
	return ""
}

// Classify maps adb error output to a protocol error code ("" if none).
func Classify(out string) string {
	l := strings.ToLower(out)
	switch {
	case strings.Contains(l, "unauthorized"), strings.Contains(l, "failed to authenticate"):
		return proto.CodeADBUnauthorized
	case strings.Contains(l, "offline"):
		return proto.CodeADBOffline
	case strings.Contains(l, "failed to connect"), strings.Contains(l, "cannot connect"),
		strings.Contains(l, "unable to connect"), strings.Contains(l, "connection refused"),
		strings.Contains(l, "no route to host"), strings.Contains(l, "timed out"),
		strings.Contains(l, "not found"), strings.Contains(l, "no devices"),
		strings.Contains(l, "network is unreachable"), strings.Contains(l, "host is down"):
		return proto.CodeUnreachable
	}
	return ""
}

// adbError reports whether stderr looks like an adb (not device) error.
func adbError(r result) (string, bool) {
	s := strings.TrimSpace(string(r.stderr))
	if len(bytes.TrimSpace(r.stdout)) > 0 {
		return "", false
	}
	if strings.HasPrefix(s, "error:") || strings.HasPrefix(s, "adb: ") || strings.HasPrefix(s, "adb:") {
		if code := Classify(s); code != "" {
			return code, true
		}
		return proto.CodeFailed, true
	}
	return "", false
}

// ParseSerial validates an ip:port serial against the target guard.
func ParseSerial(serial string) (string, error) {
	host, port, err := guard.HostPort(serial)
	if err != nil {
		return "", err
	}
	addr, ok := guard.ParseAddr(host)
	if !ok {
		return "", ops.BadArgs("serial must be ip:port, got %q", serial)
	}
	if err := guard.CheckAddr(addr); err != nil {
		return "", err
	}
	return netip.AddrPortFrom(addr, uint16(port)).String(), nil
}

// Device is one adb.devices entry.
type Device struct {
	Serial string `json:"serial"`
	State  string `json:"state"`
	Model  string `json:"model,omitempty"`
}

// ParseDevices parses `adb devices -l` output.
func ParseDevices(out string) []Device {
	devs := []Device{}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "List of devices") || strings.HasPrefix(line, "*") || strings.HasPrefix(line, "adb ") {
			continue
		}
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		d := Device{Serial: f[0], State: f[1]}
		for _, kv := range f[2:] {
			if strings.HasPrefix(kv, "model:") {
				d.Model = strings.TrimPrefix(kv, "model:")
			}
		}
		devs = append(devs, d)
	}
	return devs
}

func (a *ADB) devices(ctx context.Context) ([]Device, error) {
	r, err := a.run(ctx, 256<<10, "devices", "-l")
	if err != nil {
		return nil, err
	}
	if r.exit != 0 {
		return nil, proto.Errf(proto.CodeFailed, "adb devices: %s", r.combined())
	}
	return ParseDevices(string(r.stdout)), nil
}

func (a *ADB) state(ctx context.Context, serial string) (string, error) {
	devs, err := a.devices(ctx)
	if err != nil {
		return "", err
	}
	for _, d := range devs {
		if d.Serial == serial {
			return d.State, nil
		}
	}
	return "", nil
}

// connect runs `adb connect` and waits briefly for the state to settle.
func (a *ADB) connect(ctx context.Context, serial string) (state, output string, err error) {
	r, err := a.run(ctx, 64<<10, "connect", serial)
	if err != nil {
		return "", "", err
	}
	output = r.combined()
	low := strings.ToLower(output)
	if !strings.Contains(low, "connected to") || strings.Contains(low, "failed") || strings.Contains(low, "cannot") || strings.Contains(low, "unable") {
		if Classify(output) == proto.CodeADBUnauthorized {
			return "unauthorized", output, nil
		}
		return "unreachable", output, nil
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		st, err := a.state(ctx, serial)
		if err != nil {
			return "", output, err
		}
		if st == "device" || st == "unauthorized" || time.Now().After(deadline) {
			if st == "" {
				st = "offline"
			}
			return st, output, nil
		}
		select {
		case <-ctx.Done():
			return st, output, nil
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// ensure auto-connects serial and returns an error unless it is a usable device.
func (a *ADB) ensure(ctx context.Context, serial string) error {
	st, err := a.state(ctx, serial)
	if err != nil {
		return err
	}
	if st != "device" {
		var out string
		st, out, err = a.connect(ctx, serial)
		if err != nil {
			return err
		}
		switch st {
		case "device":
		case "unauthorized":
			return proto.Errf(proto.CodeADBUnauthorized, "%s is unauthorized; accept the debugging prompt on the device", serial)
		case "offline":
			return proto.Errf(proto.CodeADBOffline, "%s is offline", serial)
		default:
			return proto.Errf(proto.CodeUnreachable, "%s: %s", serial, out)
		}
	}
	return nil
}

func (a *ADB) need() error {
	if !a.Available() {
		return proto.Errf(proto.CodeNotSupported, "adb is not installed on this gateway")
	}
	return nil
}

func (a *ADB) tmpFile(ext string) (string, error) {
	dir := filepath.Join(a.home(), "tmp")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return filepath.Join(dir, hex.EncodeToString(b)+ext), nil
}

func (a *ADB) download(ctx context.Context, url, sha, ext string) (string, error) {
	if sha == "" {
		return "", ops.BadArgs("sha256 required")
	}
	if a.fetch == nil {
		return "", proto.Errf(proto.CodeFailed, "no download client")
	}
	path, err := a.tmpFile(ext)
	if err != nil {
		return "", err
	}
	if _, err := a.fetch.Download(ctx, url, path, sha, maxDownload); err != nil {
		os.Remove(path)
		return "", ops.Errorf(proto.AsError(err).Code, err, "download")
	}
	return path, nil
}

// --- op handlers -----------------------------------------------------------

type serialArgs struct {
	Serial string `json:"serial"`
}

func (a *ADB) opConnect(ctx context.Context, raw json.RawMessage) (any, error) {
	if err := a.need(); err != nil {
		return nil, err
	}
	var s serialArgs
	if err := ops.Decode(raw, &s); err != nil {
		return nil, err
	}
	serial, err := ParseSerial(s.Serial)
	if err != nil {
		return nil, err
	}
	if st, _ := a.state(ctx, serial); st == "device" {
		return map[string]any{"state": "device", "output": "already connected to " + serial}, nil
	}
	st, out, err := a.connect(ctx, serial)
	if err != nil {
		return nil, err
	}
	return map[string]any{"state": st, "output": out}, nil
}

func (a *ADB) opDisconnect(ctx context.Context, raw json.RawMessage) (any, error) {
	if err := a.need(); err != nil {
		return nil, err
	}
	var s serialArgs
	if err := ops.Decode(raw, &s); err != nil {
		return nil, err
	}
	serial, err := ParseSerial(s.Serial)
	if err != nil {
		return nil, err
	}
	if _, err := a.run(ctx, 64<<10, "disconnect", serial); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}

func (a *ADB) opDevices(ctx context.Context, raw json.RawMessage) (any, error) {
	if err := a.need(); err != nil {
		return nil, err
	}
	devs, err := a.devices(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]any{"devices": devs}, nil
}

func (a *ADB) opPair(ctx context.Context, raw json.RawMessage) (any, error) {
	if err := a.need(); err != nil {
		return nil, err
	}
	var p struct {
		Host string `json:"host"`
		Port int    `json:"port"`
		Code string `json:"code"`
	}
	if err := ops.Decode(raw, &p); err != nil {
		return nil, err
	}
	if p.Port < 1 || p.Port > 65535 || p.Code == "" || strings.ContainsAny(p.Code, " \n\t") {
		return nil, ops.BadArgs("host, port and code required")
	}
	addrs, err := guard.Resolve(ctx, p.Host)
	if err != nil {
		return nil, err
	}
	target := netip.AddrPortFrom(addrs[0], uint16(p.Port)).String()
	r, err := a.run(ctx, 64<<10, "pair", target, p.Code)
	if err != nil {
		return nil, err
	}
	out := r.combined()
	return map[string]any{"ok": strings.Contains(out, "Successfully paired"), "output": out}, nil
}

type shellResult struct {
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	ExitCode  int    `json:"exit_code"`
	Truncated bool   `json:"truncated,omitempty"`
}

func (a *ADB) opShell(ctx context.Context, raw json.RawMessage) (any, error) {
	if err := a.need(); err != nil {
		return nil, err
	}
	var s struct {
		Serial    string `json:"serial"`
		Cmd       string `json:"cmd"`
		TimeoutMs int64  `json:"timeout_ms"`
	}
	if err := ops.Decode(raw, &s); err != nil {
		return nil, err
	}
	serial, err := ParseSerial(s.Serial)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(s.Cmd) == "" {
		return nil, ops.BadArgs("cmd required")
	}
	if s.TimeoutMs > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(s.TimeoutMs)*time.Millisecond)
		defer cancel()
	}
	if err := a.ensure(ctx, serial); err != nil {
		return nil, err
	}
	r, err := a.run(ctx, MaxShellStdout, "-s", serial, "shell", s.Cmd)
	if err != nil {
		if pe := proto.AsError(err); pe.Code == proto.CodeTimeout {
			return nil, proto.Errf(proto.CodeTimeout, "command exceeded %dms", s.TimeoutMs)
		}
		return nil, err
	}
	if code, ok := adbError(r); ok {
		return nil, proto.Errf(code, "%s", strings.TrimSpace(string(r.stderr)))
	}
	stdout, stderr := string(r.stdout), string(r.stderr)
	data, _ := ops.FitFrame(len(stdout), func(limit int) any {
		return shellResult{Stdout: ops.TruncateUTF8(stdout, limit), Stderr: stderr, ExitCode: r.exit, Truncated: r.truncated || limit < len(stdout)}
	})
	return data, nil
}

var flagRe = regexp.MustCompile(`^--?[A-Za-z][A-Za-z0-9-]*$`)

func (a *ADB) opInstall(ctx context.Context, raw json.RawMessage) (any, error) {
	if err := a.need(); err != nil {
		return nil, err
	}
	var s struct {
		Serial string   `json:"serial"`
		URL    string   `json:"url"`
		SHA256 string   `json:"sha256"`
		Flags  []string `json:"flags"`
	}
	if err := ops.Decode(raw, &s); err != nil {
		return nil, err
	}
	serial, err := ParseSerial(s.Serial)
	if err != nil {
		return nil, err
	}
	for _, f := range s.Flags {
		if !flagRe.MatchString(f) {
			return nil, ops.BadArgs("invalid install flag %q", f)
		}
	}
	if err := a.ensure(ctx, serial); err != nil {
		return nil, err
	}
	path, err := a.download(ctx, s.URL, s.SHA256, ".apk")
	if err != nil {
		return nil, err
	}
	defer os.Remove(path)
	args := append([]string{"-s", serial, "install"}, s.Flags...)
	args = append(args, path)
	r, err := a.run(ctx, 256<<10, args...)
	if err != nil {
		return nil, err
	}
	out := r.combined()
	if r.exit != 0 || strings.Contains(out, "Failure") {
		if code, ok := adbError(r); ok && code != proto.CodeFailed {
			return nil, proto.Errf(code, "%s", out)
		}
		return nil, proto.Errf(proto.CodeFailed, "%s", ops.TruncateUTF8(out, 4096))
	}
	return map[string]any{"output": out}, nil
}

var pkgRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$`)

func (a *ADB) opUninstall(ctx context.Context, raw json.RawMessage) (any, error) {
	if err := a.need(); err != nil {
		return nil, err
	}
	var s struct {
		Serial   string `json:"serial"`
		Package  string `json:"package"`
		KeepData bool   `json:"keep_data"`
		User     *int   `json:"user"`
	}
	if err := ops.Decode(raw, &s); err != nil {
		return nil, err
	}
	serial, err := ParseSerial(s.Serial)
	if err != nil {
		return nil, err
	}
	if !pkgRe.MatchString(s.Package) {
		return nil, ops.BadArgs("invalid package name %q", s.Package)
	}
	if err := a.ensure(ctx, serial); err != nil {
		return nil, err
	}
	var args []string
	if s.User != nil {
		args = []string{"-s", serial, "shell", "pm", "uninstall"}
		if s.KeepData {
			args = append(args, "-k")
		}
		args = append(args, "--user", strconv.Itoa(*s.User), s.Package)
	} else {
		args = []string{"-s", serial, "uninstall"}
		if s.KeepData {
			args = append(args, "-k")
		}
		args = append(args, s.Package)
	}
	r, err := a.run(ctx, 64<<10, args...)
	if err != nil {
		return nil, err
	}
	out := r.combined()
	if r.exit != 0 || strings.Contains(out, "Failure") {
		return nil, proto.Errf(proto.CodeFailed, "%s", ops.TruncateUTF8(out, 4096))
	}
	return map[string]any{"output": out}, nil
}

func (a *ADB) opPush(ctx context.Context, raw json.RawMessage) (any, error) {
	if err := a.need(); err != nil {
		return nil, err
	}
	var s struct {
		Serial     string `json:"serial"`
		URL        string `json:"url"`
		SHA256     string `json:"sha256"`
		RemotePath string `json:"remote_path"`
	}
	if err := ops.Decode(raw, &s); err != nil {
		return nil, err
	}
	serial, err := ParseSerial(s.Serial)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(s.RemotePath, "/") || strings.ContainsAny(s.RemotePath, "\x00\n") {
		return nil, ops.BadArgs("remote_path must be an absolute path")
	}
	if err := a.ensure(ctx, serial); err != nil {
		return nil, err
	}
	path, err := a.download(ctx, s.URL, s.SHA256, ".bin")
	if err != nil {
		return nil, err
	}
	defer os.Remove(path)
	r, err := a.run(ctx, 64<<10, "-s", serial, "push", path, s.RemotePath)
	if err != nil {
		return nil, err
	}
	out := r.combined()
	if r.exit != 0 {
		if code, ok := adbError(r); ok && code != proto.CodeFailed {
			return nil, proto.Errf(code, "%s", out)
		}
		return nil, proto.Errf(proto.CodeFailed, "%s", ops.TruncateUTF8(out, 4096))
	}
	return map[string]any{"output": out}, nil
}

func (a *ADB) opScreencap(ctx context.Context, raw json.RawMessage) (any, error) {
	if err := a.need(); err != nil {
		return nil, err
	}
	var s struct {
		Serial    string `json:"serial"`
		UploadURL string `json:"upload_url"`
		MaxWidth  int    `json:"max_width"`
		Quality   int    `json:"quality"`
	}
	if err := ops.Decode(raw, &s); err != nil {
		return nil, err
	}
	serial, err := ParseSerial(s.Serial)
	if err != nil {
		return nil, err
	}
	if s.MaxWidth <= 0 {
		s.MaxWidth = 1280
	}
	if s.Quality <= 0 || s.Quality > 100 {
		s.Quality = 70
	}
	if a.fetch == nil {
		return nil, proto.Errf(proto.CodeFailed, "no upload client")
	}
	if _, err := a.fetch.Check(s.UploadURL); err != nil {
		return nil, err
	}
	if err := a.ensure(ctx, serial); err != nil {
		return nil, err
	}
	r, err := a.run(ctx, maxScreencap, "-s", serial, "exec-out", "screencap", "-p")
	if err != nil {
		return nil, err
	}
	if code, ok := adbError(r); ok {
		return nil, proto.Errf(code, "%s", strings.TrimSpace(string(r.stderr)))
	}
	if r.exit != 0 || len(r.stdout) == 0 {
		return nil, proto.Errf(proto.CodeFailed, "screencap failed: %s", r.combined())
	}
	if r.truncated {
		return nil, proto.Errf(proto.CodeFailed, "screencap larger than %d bytes", maxScreencap)
	}
	jpg, w, h, err := PNGToJPEG(r.stdout, s.MaxWidth, s.Quality)
	if err != nil {
		return nil, proto.Errf(proto.CodeFailed, "decode screencap: %v", err)
	}
	if err := a.fetch.Put(ctx, s.UploadURL, "image/jpeg", jpg); err != nil {
		var pe *proto.Error
		if errors.As(err, &pe) {
			return nil, pe
		}
		return nil, proto.Errf(proto.CodeFailed, "upload: %v", err)
	}
	return map[string]any{"bytes": len(jpg), "width": w, "height": h, "content_type": "image/jpeg"}, nil
}

// Register adds the adb ops.
func (a *ADB) Register(r *ops.Registry) {
	r.Register("adb.connect", a.opConnect)
	r.Register("adb.disconnect", a.opDisconnect)
	r.Register("adb.devices", a.opDevices)
	r.Register("adb.pair", a.opPair)
	r.Register("adb.shell", a.opShell)
	r.Register("adb.install", a.opInstall)
	r.Register("adb.uninstall", a.opUninstall)
	r.Register("adb.screencap", a.opScreencap)
	r.Register("adb.push", a.opPush)
}
