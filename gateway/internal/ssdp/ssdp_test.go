package ssdp

import (
	"testing"
	"time"
)

func TestParse(t *testing.T) {
	m, ok := Parse([]byte("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 3\r\nST: urn:dial-multiscreen-org:service:dial:1\r\n\r\n"))
	if !ok || m.Kind != "M-SEARCH" || m.Headers["st"] != "urn:dial-multiscreen-org:service:dial:1" || m.Wait() != 4*time.Second {
		t.Fatalf("%+v", m)
	}
	m, ok = Parse([]byte("NOTIFY * HTTP/1.1\r\nHost: 239.255.255.250:1900\r\nNT: upnp:rootdevice\r\nNTS: ssdp:alive\r\nLocation: http://10.0.20.40:7676/rcr/\r\n\r\n"))
	if !ok || m.Kind != "NOTIFY" || m.Headers["location"] != "http://10.0.20.40:7676/rcr/" {
		t.Fatalf("%+v", m)
	}
	m, ok = Parse([]byte("HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: http://10.0.20.40:8008/ssdp/device-desc.xml\r\nSERVER: Linux/3.8 UPnP/1.0\r\nST: upnp:rootdevice\r\nUSN: uuid:abc::upnp:rootdevice\r\n\r\n"))
	if !ok || m.Kind != "RESPONSE" || m.Headers["usn"] != "uuid:abc::upnp:rootdevice" {
		t.Fatalf("%+v", m)
	}
	if _, ok := Parse([]byte("GET / HTTP/1.1\r\n\r\n")); ok {
		t.Fatal("GET accepted")
	}
	if _, ok := Parse(nil); ok {
		t.Fatal("empty accepted")
	}
}

func TestWait(t *testing.T) {
	cases := map[string]time.Duration{"": 2 * time.Second, "0": time.Second, "1": 2 * time.Second, "10": 5 * time.Second, "x": 2 * time.Second}
	for mx, want := range cases {
		m := Message{Headers: map[string]string{}}
		if mx != "" {
			m.Headers["mx"] = mx
		}
		if got := m.Wait(); got != want {
			t.Errorf("mx=%q wait=%v want %v", mx, got, want)
		}
	}
}

func TestSearchRequest(t *testing.T) {
	m, ok := Parse(SearchRequest("", 2))
	if !ok || m.Kind != "M-SEARCH" || m.Headers["st"] != "ssdp:all" || m.Headers["mx"] != "2" || m.Headers["man"] != `"ssdp:discover"` {
		t.Fatalf("%+v", m)
	}
}
