//go:build e2ebinary

package agent

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// TestBinaryWSOpen runs a built binary as a subprocess against the fake hub,
// with a Samsung-like wss device (speaks first) on a private address, i.e.
// with the production guard (no loopback hook). Opt-in:
//
//	GW_BIN=$PWD/dist/screens-gateway-linux-amd64 DEV_IP=10.x.y.z \
//	  go test -tags e2ebinary -run TestBinaryWSOpen -v ./internal/agent/
//
// DEV_IP must be a private address configured on this host.
func TestBinaryWSOpen(t *testing.T) {
	bin := os.Getenv("GW_BIN")
	devIP := os.Getenv("DEV_IP")
	if bin == "" || devIP == "" {
		t.Skip("set GW_BIN and DEV_IP")
	}
	hub := newFakeHub(t)
	got := make(chan string, 4)
	ln, err := net.Listen("tcp", devIP+":0")
	if err != nil {
		t.Fatal(err)
	}
	dev := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		_ = c.Write(r.Context(), websocket.MessageText, []byte(`{"event":"ms.channel.connect"}`))
		for {
			_, b, err := c.Read(r.Context())
			if err != nil {
				return
			}
			got <- string(b)
			_ = c.Write(r.Context(), websocket.MessageText, append([]byte("ack:"), b...))
		}
	}))
	dev.Listener = ln
	dev.TLS = &tls.Config{}
	dev.StartTLS()
	defer dev.Close()

	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := exec.CommandContext(ctx, bin)
	cmd.Env = append(os.Environ(), "SCREENS_CENTRAL_URL="+hub.srv.URL, "SCREENS_ENROLL_TOKEN=enr_test", "SCREENS_DATA="+dir, "SCREENS_LOG_LEVEL=debug")
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	var hc *hubConn
	select {
	case hc = <-hub.conns:
	case <-time.After(15 * time.Second):
		t.Fatal("binary never connected")
	}
	<-hc.hello
	u := "wss" + strings.TrimPrefix(dev.URL, "https") + "/api/v2/channels/samsung.remote.control?name=U2NyZWVucw%3D%3D"
	r := hc.call("ws.open", map[string]any{"stream": "s_1", "url": u, "headers": map[string]string{}, "insecure_tls": true}, 15*time.Second)
	if r["ok"] != true {
		t.Fatalf("ws.open %v", r)
	}
	hc.send(map[string]any{"t": "stream", "stream": "s_1", "kind": "text", "data": "KEY_HOME"})
	for i := 0; i < 2; i++ {
		select {
		case f := <-hc.stream:
			t.Logf("hub got stream frame: %v", f)
		case <-time.After(5 * time.Second):
			t.Fatalf("hub got only %d stream frames", i)
		}
	}
	select {
	case m := <-got:
		t.Logf("device got %q", m)
	case <-time.After(5 * time.Second):
		t.Fatal("device got nothing")
	}
}
