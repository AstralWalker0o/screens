package adb

import (
	"context"
	"fmt"
	"io"
	"net"
	"strconv"
	"testing"
	"time"
)

// fakeADBServer speaks the adb smart-socket protocol for one connection.
func fakeADBServer(t *testing.T, reply func(req string) string) (addr string, got chan []string, payload chan []byte) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	got = make(chan []string, 1)
	payload = make(chan []byte, 1)
	go func() {
		defer ln.Close()
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		var reqs []string
		for i := 0; i < 2; i++ {
			h := make([]byte, 4)
			if _, err := io.ReadFull(c, h); err != nil {
				got <- reqs
				return
			}
			n, _ := strconv.ParseUint(string(h), 16, 16)
			b := make([]byte, n)
			io.ReadFull(c, b)
			reqs = append(reqs, string(b))
			r := reply(string(b))
			if r != "OKAY" {
				fmt.Fprintf(c, "FAIL%04x%s", len(r), r)
				got <- reqs
				return
			}
			c.Write([]byte("OKAY"))
		}
		got <- reqs
		c.Write([]byte{0, 'h', 'i'})
		buf := make([]byte, 5)
		io.ReadFull(c, buf)
		payload <- buf
	}()
	return ln.Addr().String(), got, payload
}

func TestDialServiceHandshakeAndStream(t *testing.T) {
	addr, got, payload := fakeADBServer(t, func(string) string { return "OKAY" })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := DialService(ctx, addr, "10.0.20.31:5555", "localabstract:scrcpy_0123abcd")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	reqs := <-got
	if len(reqs) != 2 || reqs[0] != "host:transport:10.0.20.31:5555" || reqs[1] != "localabstract:scrcpy_0123abcd" {
		t.Fatalf("requests: %q", reqs)
	}
	b := make([]byte, 3)
	if _, err := io.ReadFull(c, b); err != nil || string(b) != "\x00hi" {
		t.Fatalf("read %q %v", b, err)
	}
	c.Write([]byte("hello"))
	if p := <-payload; string(p) != "hello" {
		t.Fatalf("payload %q", p)
	}
}

func TestDialServiceFailure(t *testing.T) {
	addr, _, _ := fakeADBServer(t, func(req string) string {
		if req == "localabstract:scrcpy_0123abcd" {
			return "closed"
		}
		return "OKAY"
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := DialService(ctx, addr, "10.0.20.31:5555", "localabstract:scrcpy_0123abcd"); err == nil || err.Error() == "" {
		t.Fatal("expected FAIL to surface as error")
	}
}

func TestServiceAllowlist(t *testing.T) {
	for _, s := range []string{"localabstract:scrcpy_0123abcd"} {
		if !ServiceRe.MatchString(s) {
			t.Fatalf("should allow %s", s)
		}
	}
	for _, s := range []string{"shell:rm -rf /", "tcp:5555", "localabstract:scrcpy", "localabstract:scrcpy_0123ABCD", "localabstract:other_0123abcd", "localabstract:scrcpy_0123abcd\x00"} {
		if ServiceRe.MatchString(s) {
			t.Fatalf("should refuse %q", s)
		}
	}
}
