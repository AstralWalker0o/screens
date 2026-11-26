package adb

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"regexp"
	"strconv"
	"time"

	"github.com/astralwalker0o/screens/gateway/internal/proto"
)

// ServiceRe limits adb.stream to scrcpy's local sockets (see docs/MIRROR.md).
var ServiceRe = regexp.MustCompile(`^localabstract:scrcpy_[0-9a-f]{8}$`)

// serverAddr is the local adb server (smart-socket protocol).
func serverAddr() string {
	port := 5037
	if p, err := strconv.Atoi(os.Getenv("ANDROID_ADB_SERVER_PORT")); err == nil && p > 0 && p < 65536 {
		port = p
	}
	return net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
}

// OpenService connects a device-side service (e.g. localabstract:scrcpy_0123abcd) through the local adb server
// and returns the raw byte stream. The device must be reachable and authorised.
func (a *ADB) OpenService(ctx context.Context, serial, service string) (net.Conn, error) {
	if err := a.need(); err != nil {
		return nil, err
	}
	if !ServiceRe.MatchString(service) {
		return nil, proto.Errf(proto.CodeForbidden, "service %q is not allowed", service)
	}
	if _, err := ParseSerial(serial); err != nil {
		return nil, err
	}
	if err := a.ensureServer(ctx); err != nil {
		return nil, err
	}
	if err := a.ensure(ctx, serial); err != nil {
		return nil, err
	}
	return DialService(ctx, serverAddr(), serial, service)
}

// DialService performs the adb smart-socket handshake: host:transport:<serial>, then <service>.
func DialService(ctx context.Context, addr, serial, service string) (net.Conn, error) {
	d := net.Dialer{Timeout: 5 * time.Second}
	c, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, proto.Errf(proto.CodeUnreachable, "adb server: %v", err)
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = c.SetDeadline(dl)
	} else {
		_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	}
	for _, req := range []string{"host:transport:" + serial, service} {
		if err := smartRequest(c, req); err != nil {
			c.Close()
			return nil, err
		}
	}
	_ = c.SetDeadline(time.Time{})
	return c, nil
}

func smartRequest(c net.Conn, req string) error {
	if _, err := fmt.Fprintf(c, "%04x%s", len(req), req); err != nil {
		return proto.Errf(proto.CodeUnreachable, "adb server write: %v", err)
	}
	status := make([]byte, 4)
	if _, err := io.ReadFull(c, status); err != nil {
		return proto.Errf(proto.CodeUnreachable, "adb server read: %v", err)
	}
	switch string(status) {
	case "OKAY":
		return nil
	case "FAIL":
		msg := "unknown error"
		lenHex := make([]byte, 4)
		if _, err := io.ReadFull(c, lenHex); err == nil {
			if n, err := strconv.ParseUint(string(lenHex), 16, 16); err == nil {
				b := make([]byte, n)
				if _, err := io.ReadFull(c, b); err == nil {
					msg = string(b)
				}
			}
		}
		return proto.Errf(proto.CodeFailed, "adb: %s", msg)
	default:
		return proto.Errf(proto.CodeFailed, "adb: unexpected reply %q", status)
	}
}
