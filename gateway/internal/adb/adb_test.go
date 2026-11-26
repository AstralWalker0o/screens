package adb

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/astralwalker0o/screens/gateway/internal/fetch"
	"github.com/astralwalker0o/screens/gateway/internal/proto"
)

const fakeADB = `#!/bin/sh
echo "$*" >> "$FAKE_LOG"
case "$*" in
  "start-server") exit 0 ;;
  "version") echo "Android Debug Bridge version 1.0.41"; echo "Version 35.0.2"; exit 0 ;;
  "devices -l")
    echo "List of devices attached"
    echo "10.0.20.31:5555        device product:mdarcy model:SHIELD_Android_TV device:mdarcy transport_id:1"
    echo "10.0.20.32:5555        unauthorized transport_id:2"
    if [ -f "$FAKE_DIR/connected33" ]; then echo "10.0.20.33:5555 device model:Chromecast transport_id:3"; fi
    echo ""
    exit 0 ;;
  "connect 10.0.20.31:5555") echo "already connected to 10.0.20.31:5555"; exit 0 ;;
  "connect 10.0.20.32:5555") echo "already connected to 10.0.20.32:5555"; exit 0 ;;
  "connect 10.0.20.33:5555") touch "$FAKE_DIR/connected33"; echo "connected to 10.0.20.33:5555"; exit 0 ;;
  "connect 10.0.20.34:5555") echo "failed to connect to '10.0.20.34:5555': Connection refused"; exit 1 ;;
  "-s 10.0.20.31:5555 shell getprop ro.product.model") echo "SHIELD Android TV"; exit 0 ;;
  "-s 10.0.20.33:5555 shell getprop ro.product.model") echo "Chromecast"; exit 0 ;;
  "-s 10.0.20.31:5555 shell echo \$HOME") echo "$HOME|$ANDROID_USER_HOME"; exit 0 ;;
  "-s 10.0.20.31:5555 shell false") echo "sh: nope: not found" >&2; exit 127 ;;
  "-s 10.0.20.31:5555 shell offline") echo "error: device offline" >&2; exit 1 ;;
  "-s 10.0.20.31:5555 exec-out screencap -p") cat "$FAKE_DIR/shot.png"; exit 0 ;;
  "-s 10.0.20.31:5555 install -r -g "*) echo "Performing Streamed Install"; echo "Success"; exit 0 ;;
  "-s 10.0.20.31:5555 uninstall com.example.app") echo "Success"; exit 0 ;;
  "-s 10.0.20.31:5555 shell pm uninstall -k --user 0 com.example.app") echo "Success"; exit 0 ;;
  "pair 10.0.20.31:37000 123456") echo "Successfully paired to 10.0.20.31:37000 [guid=adb-x]"; exit 0 ;;
esac
echo "unexpected: $*" >&2
exit 1
`

func setup(t *testing.T) (*ADB, string, *httptest.Server, *[]byte) {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "adb")
	if err := os.WriteFile(bin, []byte(fakeADB), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_DIR", dir)
	t.Setenv("FAKE_LOG", filepath.Join(dir, "log"))

	img := image.NewNRGBA(image.Rect(0, 0, 1920, 1080))
	for y := 0; y < 1080; y++ {
		for x := 0; x < 1920; x++ {
			img.Set(x, y, color.NRGBA{R: uint8(x), G: uint8(y), B: 128, A: 255})
		}
	}
	var pngBuf bytes.Buffer
	_ = png.Encode(&pngBuf, img)
	_ = os.WriteFile(filepath.Join(dir, "shot.png"), pngBuf.Bytes(), 0o644)

	var uploaded []byte
	apk := []byte("PK fake apk")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPut && r.Header.Get("Content-Type") == "image/jpeg":
			uploaded, _ = io.ReadAll(r.Body)
		case r.Method == http.MethodGet:
			_, _ = w.Write(apk)
		default:
			w.WriteHeader(400)
		}
	}))
	t.Cleanup(srv.Close)
	a := New(filepath.Join(dir, "data"), fetch.New(srv.URL), slog.New(slog.NewTextHandler(io.Discard, nil)))
	a.Bin = bin
	return a, dir, srv, &uploaded
}

func code(err error) string {
	var pe *proto.Error
	if errors.As(err, &pe) {
		return pe.Code
	}
	if err == nil {
		return ""
	}
	return "?" + err.Error()
}

func TestADBOps(t *testing.T) {
	a, dir, srv, uploaded := setup(t)
	ctx := context.Background()
	if v := a.Version(ctx); v != "1.0.41" {
		t.Fatalf("version %q", v)
	}
	d, err := a.opDevices(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	devs := d.(map[string]any)["devices"].([]Device)
	if len(devs) != 2 || devs[0].Model != "SHIELD_Android_TV" || devs[1].State != "unauthorized" {
		t.Fatalf("devices %+v", devs)
	}

	d, err = a.opShell(ctx, json.RawMessage(`{"serial":"10.0.20.31:5555","cmd":"getprop ro.product.model"}`))
	if err != nil {
		t.Fatal(err)
	}
	if r := d.(shellResult); r.Stdout != "SHIELD Android TV\n" || r.ExitCode != 0 {
		t.Fatalf("shell %+v", r)
	}
	d, _ = a.opShell(ctx, json.RawMessage(`{"serial":"10.0.20.31:5555","cmd":"echo $HOME"}`))
	home := filepath.Join(dir, "data", "adb")
	if r := d.(shellResult); strings.TrimSpace(r.Stdout) != home+"|"+home {
		t.Fatalf("env %q", r.Stdout)
	}
	// Device command failing is not an adb error.
	d, err = a.opShell(ctx, json.RawMessage(`{"serial":"10.0.20.31:5555","cmd":"false"}`))
	if err != nil || d.(shellResult).ExitCode != 127 {
		t.Fatalf("exit code: %v %v", d, err)
	}
	if _, err = a.opShell(ctx, json.RawMessage(`{"serial":"10.0.20.31:5555","cmd":"offline"}`)); code(err) != proto.CodeADBOffline {
		t.Fatalf("offline: %v", err)
	}
	// Auto-connect.
	d, err = a.opShell(ctx, json.RawMessage(`{"serial":"10.0.20.33:5555","cmd":"getprop ro.product.model"}`))
	if err != nil || d.(shellResult).Stdout != "Chromecast\n" {
		t.Fatalf("auto-connect: %v %v", d, err)
	}
	log, _ := os.ReadFile(filepath.Join(dir, "log"))
	if !strings.Contains(string(log), "connect 10.0.20.33:5555") || strings.Count(string(log), "start-server") != 1 {
		t.Fatalf("log:\n%s", log)
	}
	if _, err = a.opShell(ctx, json.RawMessage(`{"serial":"10.0.20.32:5555","cmd":"x"}`)); code(err) != proto.CodeADBUnauthorized {
		t.Fatalf("unauthorized: %v", err)
	}
	if _, err = a.opShell(ctx, json.RawMessage(`{"serial":"10.0.20.34:5555","cmd":"x"}`)); code(err) != proto.CodeUnreachable {
		t.Fatalf("unreachable: %v", err)
	}
	// Guard.
	for _, s := range []string{"127.0.0.1:5555", "8.8.8.8:5555", "tv.local:5555", "10.0.20.31"} {
		if _, err := a.opShell(ctx, json.RawMessage(`{"serial":"`+s+`","cmd":"x"}`)); code(err) != proto.CodeForbidden && code(err) != proto.CodeBadArgs {
			t.Errorf("serial %s: %v", s, err)
		}
	}

	// adb.connect returns states, not errors.
	d, _ = a.opConnect(ctx, json.RawMessage(`{"serial":"10.0.20.32:5555"}`))
	if d.(map[string]any)["state"] != "unauthorized" {
		t.Fatalf("connect unauthorized %v", d)
	}
	d, _ = a.opConnect(ctx, json.RawMessage(`{"serial":"10.0.20.34:5555"}`))
	if d.(map[string]any)["state"] != "unreachable" {
		t.Fatalf("connect unreachable %v", d)
	}

	// Screencap → JPEG upload.
	d, err = a.opScreencap(ctx, json.RawMessage(`{"serial":"10.0.20.31:5555","upload_url":"`+srv.URL+`/agent/v1/upload/k?exp=1&sig=a","max_width":640}`))
	if err != nil {
		t.Fatal(err)
	}
	m := d.(map[string]any)
	if m["width"] != 640 || m["height"] != 360 || m["content_type"] != "image/jpeg" || m["bytes"] != len(*uploaded) {
		t.Fatalf("screencap %v", m)
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(*uploaded))
	if err != nil || cfg.Width != 640 || cfg.Height != 360 {
		t.Fatalf("uploaded jpeg %v %v", cfg, err)
	}
	if _, err := a.opScreencap(ctx, json.RawMessage(`{"serial":"10.0.20.31:5555","upload_url":"https://evil.example/x"}`)); code(err) != proto.CodeForbidden {
		t.Fatalf("upload elsewhere: %v", err)
	}

	// Install with sha verification.
	sum := sha256.Sum256([]byte("PK fake apk"))
	d, err = a.opInstall(ctx, json.RawMessage(`{"serial":"10.0.20.31:5555","url":"`+srv.URL+`/agent/v1/files/apk","sha256":"`+hex.EncodeToString(sum[:])+`","flags":["-r","-g"]}`))
	if err != nil || !strings.Contains(d.(map[string]any)["output"].(string), "Success") {
		t.Fatalf("install %v %v", d, err)
	}
	if _, err := a.opInstall(ctx, json.RawMessage(`{"serial":"10.0.20.31:5555","url":"`+srv.URL+`/x","sha256":"00","flags":["-r"]}`)); code(err) != proto.CodeFailed {
		t.Fatalf("bad sha: %v", err)
	}
	if _, err := a.opInstall(ctx, json.RawMessage(`{"serial":"10.0.20.31:5555","url":"`+srv.URL+`/x","sha256":"00","flags":["; rm -rf /"]}`)); code(err) != proto.CodeBadArgs {
		t.Fatalf("bad flag: %v", err)
	}
	if ents, _ := os.ReadDir(filepath.Join(dir, "data", "adb", "tmp")); len(ents) != 0 {
		t.Fatalf("temp files left: %v", ents)
	}

	if _, err := a.opUninstall(ctx, json.RawMessage(`{"serial":"10.0.20.31:5555","package":"com.example.app"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := a.opUninstall(ctx, json.RawMessage(`{"serial":"10.0.20.31:5555","package":"com.example.app","keep_data":true,"user":0}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := a.opUninstall(ctx, json.RawMessage(`{"serial":"10.0.20.31:5555","package":"x; reboot"}`)); code(err) != proto.CodeBadArgs {
		t.Fatalf("bad package: %v", err)
	}
	d, err = a.opPair(ctx, json.RawMessage(`{"host":"10.0.20.31","port":37000,"code":"123456"}`))
	if err != nil || d.(map[string]any)["ok"] != true {
		t.Fatalf("pair %v %v", d, err)
	}
}

func TestNoADB(t *testing.T) {
	a := New(t.TempDir(), nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	a.Bin = "/nonexistent/adb"
	if a.Available() {
		t.Fatal("available")
	}
	for _, h := range []func(context.Context, json.RawMessage) (any, error){a.opDevices, a.opShell, a.opConnect, a.opScreencap} {
		if _, err := h(context.Background(), json.RawMessage(`{"serial":"10.0.0.1:5555","cmd":"x"}`)); code(err) != proto.CodeNotSupported {
			t.Fatalf("want not_supported, got %v", err)
		}
	}
	if a.Version(context.Background()) != "" {
		t.Fatal("version without adb")
	}
}

func TestClassify(t *testing.T) {
	cases := map[string]string{
		"error: device unauthorized.\nThis adb server's $ADB_VENDOR_KEYS is not set": proto.CodeADBUnauthorized,
		"failed to authenticate to 10.0.0.1:5555":                                    proto.CodeADBUnauthorized,
		"error: device offline":                                                      proto.CodeADBOffline,
		"failed to connect to '10.0.0.1:5555': Connection refused":                   proto.CodeUnreachable,
		"cannot connect to 10.0.0.1:5555: No route to host (113)":                    proto.CodeUnreachable,
		"error: device '10.0.0.1:5555' not found":                                    proto.CodeUnreachable,
		"something else": "",
	}
	for in, want := range cases {
		if got := Classify(in); got != want {
			t.Errorf("Classify(%q) = %q want %q", in, got, want)
		}
	}
}

func TestDownscale(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 4, 2))
	for x := 0; x < 4; x++ {
		for y := 0; y < 2; y++ {
			v := uint8(0)
			if x%2 == 1 {
				v = 200
			}
			src.Set(x, y, color.RGBA{v, v, v, 255})
		}
	}
	d := Downscale(src, 2)
	if d.Rect.Dx() != 2 || d.Rect.Dy() != 1 {
		t.Fatalf("size %v", d.Rect)
	}
	if c := d.RGBAAt(0, 0); c.R != 100 {
		t.Fatalf("average %v", c)
	}
	if Downscale(src, 100).Rect.Dx() != 4 {
		t.Fatal("upscaled")
	}
}
