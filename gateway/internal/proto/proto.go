// Package proto holds the wire types and error codes shared by every part of
// the gateway (see docs/PROTOCOL.md §3).
package proto

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"
)

// MaxFrame is the largest WebSocket frame either side may send (§3).
const MaxFrame = 512 * 1024

// Frame types.
const (
	TypeHello   = "hello"
	TypeWelcome = "welcome"
	TypeReq     = "req"
	TypeRes     = "res"
	TypeEvt     = "evt"
	TypeStream  = "stream"
	TypePing    = "ping"
	TypePong    = "pong"
)

// Error codes (§3 req/res).
const (
	CodeBadArgs         = "bad_args"
	CodeUnknownOp       = "unknown_op"
	CodeTimeout         = "timeout"
	CodeForbidden       = "forbidden"
	CodeUnreachable     = "unreachable"
	CodeADBUnauthorized = "adb_unauthorized"
	CodeADBOffline      = "adb_offline"
	CodeFailed          = "failed"
	CodeNotSupported    = "not_supported"
)

// Error is an operation error carrying one of the protocol error codes.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Errf builds an *Error.
func Errf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// AsError converts any error into a protocol error. Context deadline errors
// become "timeout", everything without a code becomes "failed".
func AsError(err error) *Error {
	if err == nil {
		return nil
	}
	var pe *Error
	if errors.As(err, &pe) {
		return pe
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, os.ErrDeadlineExceeded) {
		return &Error{Code: CodeTimeout, Message: err.Error()}
	}
	return &Error{Code: CodeFailed, Message: err.Error()}
}

// Envelope is used to peek at the type of an inbound frame.
type Envelope struct {
	T string `json:"t"`
}

// Req is a hub → agent request.
type Req struct {
	T         string          `json:"t"`
	ID        string          `json:"id"`
	Op        string          `json:"op"`
	Args      json.RawMessage `json:"args,omitempty"`
	TimeoutMs int64           `json:"timeout_ms,omitempty"`
}

// Res is an agent → hub result.
type Res struct {
	T     string `json:"t"`
	ID    string `json:"id"`
	OK    bool   `json:"ok"`
	Data  any    `json:"data,omitempty"`
	Error *Error `json:"error,omitempty"`
}

// Evt is an unsolicited agent → hub event.
type Evt struct {
	T    string `json:"t"`
	Type string `json:"type"`
	Data any    `json:"data"`
}

// Ping / pong keepalive.
type Ping struct {
	T  string `json:"t"`
	Ts int64  `json:"ts"`
}

// Welcome is the hub's reply to hello.
type Welcome struct {
	T          string        `json:"t"`
	SiteID     string        `json:"site_id"`
	ServerTime int64         `json:"server_time"`
	Config     WelcomeConfig `json:"config"`
	// BinaryStreams: the hub accepts and sends binary stream frames (see EncodeBinaryStream).
	BinaryStreams bool `json:"binary_streams,omitempty"`
}

// BinaryStreamTag is the first byte of a binary stream-data WebSocket frame.
const BinaryStreamTag = 0x01

// EncodeBinaryStream builds a binary frame: 0x01, len(id), id, payload.
func EncodeBinaryStream(id string, payload []byte) []byte {
	b := make([]byte, 0, 2+len(id)+len(payload))
	b = append(b, BinaryStreamTag, byte(len(id)))
	b = append(b, id...)
	return append(b, payload...)
}

// DecodeBinaryStream parses a binary stream-data frame.
func DecodeBinaryStream(b []byte) (id string, payload []byte, ok bool) {
	if len(b) < 2 || b[0] != BinaryStreamTag {
		return "", nil, false
	}
	n := int(b[1])
	if n == 0 || len(b) < 2+n {
		return "", nil, false
	}
	return string(b[2 : 2+n]), b[2+n:], true
}

// WelcomeConfig is the initial configuration carried by welcome.
type WelcomeConfig struct {
	DNS       json.RawMessage `json:"dns,omitempty"`
	MDNS      json.RawMessage `json:"mdns,omitempty"`
	Net       json.RawMessage `json:"net,omitempty"`
	Telemetry *Telemetry      `json:"telemetry,omitempty"`
}

// Telemetry intervals.
type Telemetry struct {
	DNSBatchMs  int64 `json:"dns_batch_ms,omitempty"`
	MetricsMs   int64 `json:"metrics_ms,omitempty"`
	NeighborsMs int64 `json:"neighbors_ms,omitempty"`
}

// WithDefaults fills zero intervals with the protocol defaults.
func (t Telemetry) WithDefaults() Telemetry {
	if t.DNSBatchMs <= 0 {
		t.DNSBatchMs = 5000
	}
	if t.MetricsMs <= 0 {
		t.MetricsMs = 60000
	}
	if t.NeighborsMs <= 0 {
		t.NeighborsMs = 300000
	}
	return t
}

// Stream is a relay stream frame, in either direction.
type Stream struct {
	T       string  `json:"t"`
	Stream  string  `json:"stream"`
	Kind    string  `json:"kind"`
	Data    *string `json:"data,omitempty"`
	DataB64 *string `json:"data_b64,omitempty"`
	Code    *int    `json:"code,omitempty"`
	Reason  *string `json:"reason,omitempty"`
}

// Stream kinds.
const (
	KindText   = "text"
	KindBinary = "binary"
	KindClose  = "close"
)

// StreamText builds a text stream frame.
func StreamText(id, data string) *Stream {
	return &Stream{T: TypeStream, Stream: id, Kind: KindText, Data: &data}
}

// StreamBinary builds a binary stream frame from already-encoded base64.
func StreamBinary(id, b64 string) *Stream {
	return &Stream{T: TypeStream, Stream: id, Kind: KindBinary, DataB64: &b64}
}

// StreamClose builds a close stream frame.
func StreamClose(id string, code int, reason string) *Stream {
	return &Stream{T: TypeStream, Stream: id, Kind: KindClose, Code: &code, Reason: &reason}
}

// Interface describes a network interface in hello / sys.info.
type Interface struct {
	Name      string   `json:"name"`
	MAC       string   `json:"mac"`
	Addrs     []string `json:"addrs"`
	Up        bool     `json:"up"`
	Multicast bool     `json:"multicast"`
}

// Hello is the first agent → hub frame.
type Hello struct {
	T          string      `json:"t"`
	Version    string      `json:"version"`
	Hostname   string      `json:"hostname"`
	OS         string      `json:"os"`
	Arch       string      `json:"arch"`
	StartedAt  int64       `json:"started_at"`
	Interfaces []Interface `json:"interfaces"`
	Caps       []string    `json:"caps"`
	DNS        HelloDNS    `json:"dns"`
	ADBVersion string      `json:"adb_version,omitempty"`
}

// HelloDNS is the DNS status block in hello.
type HelloDNS struct {
	Listening      []string          `json:"listening"`
	DoTListening   []string          `json:"dot_listening"`
	PolicyVersions map[string]string `json:"policy_versions"`
}

// NowMs is the current time in epoch milliseconds.
func NowMs() int64 { return time.Now().UnixMilli() }

// FrameSize returns the encoded JSON size of v.
func FrameSize(v any) int {
	b, err := json.Marshal(v)
	if err != nil {
		return 0
	}
	return len(b)
}

// ErrFrameTooLarge is returned when a frame would exceed MaxFrame.
var ErrFrameTooLarge = errors.New("frame exceeds 512 KiB")

// FrameBudget is the space left for op result data inside a res frame after
// the envelope ({"t":"res","id":...,"ok":true,"data":}) plus a safety margin.
const FrameBudget = MaxFrame - 4096
