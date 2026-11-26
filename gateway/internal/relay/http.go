package relay

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/astralwalker0o/screens/gateway/internal/guard"
	"github.com/astralwalker0o/screens/gateway/internal/ops"
	"github.com/astralwalker0o/screens/gateway/internal/proto"
)

// Body limits for http.request.
const (
	DefaultMaxBody = 2 << 20
	MaxMaxBody     = 8 << 20
)

type httpArgs struct {
	URL             string            `json:"url"`
	Method          string            `json:"method"`
	Headers         map[string]string `json:"headers"`
	Body            *string           `json:"body"`
	BodyB64         string            `json:"body_b64"`
	TimeoutMs       int64             `json:"timeout_ms"`
	InsecureTLS     *bool             `json:"insecure_tls"`
	MaxBody         int64             `json:"max_body"`
	FollowRedirects bool              `json:"follow_redirects"`
}

// HTTPResult is the http.request result.
type HTTPResult struct {
	Status    int               `json:"status"`
	Headers   map[string]string `json:"headers"`
	Body      *string           `json:"body,omitempty"`
	BodyB64   *string           `json:"body_b64,omitempty"`
	Truncated bool              `json:"truncated"`
}

func validMethod(m string) bool {
	if m == "" || len(m) > 20 {
		return false
	}
	for _, r := range m {
		if !(r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r == '-') {
			return false
		}
	}
	return true
}

// mapErr turns transport errors into protocol errors.
func mapErr(ctx context.Context, err error) error {
	var pe *proto.Error
	if errors.As(err, &pe) {
		return pe
	}
	if ctx.Err() != nil || errors.Is(err, context.DeadlineExceeded) {
		return proto.Errf(proto.CodeTimeout, "%v", err)
	}
	var ue *url.Error
	if errors.As(err, &ue) && ue.Timeout() {
		return proto.Errf(proto.CodeTimeout, "%v", err)
	}
	return proto.Errf(proto.CodeFailed, "%v", err)
}

// HTTPRequest implements http.request.
func (m *Manager) HTTPRequest(ctx context.Context, raw json.RawMessage) (any, error) {
	var a httpArgs
	if err := ops.Decode(raw, &a); err != nil {
		return nil, err
	}
	u, err := url.Parse(a.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, ops.BadArgs("url must be an absolute http(s) URL")
	}
	if a.Method == "" {
		a.Method = http.MethodGet
	}
	a.Method = strings.ToUpper(a.Method)
	if !validMethod(a.Method) {
		return nil, ops.BadArgs("invalid method %q", a.Method)
	}
	if _, err := guard.Resolve(ctx, u.Hostname()); err != nil {
		return nil, err
	}
	var body io.Reader
	switch {
	case a.BodyB64 != "":
		b, err := base64.StdEncoding.DecodeString(a.BodyB64)
		if err != nil {
			return nil, ops.BadArgs("body_b64: %v", err)
		}
		body = bytes.NewReader(b)
	case a.Body != nil:
		body = strings.NewReader(*a.Body)
	}
	maxBody := a.MaxBody
	if maxBody <= 0 {
		maxBody = DefaultMaxBody
	}
	if maxBody > MaxMaxBody {
		maxBody = MaxMaxBody
	}
	if a.TimeoutMs > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(a.TimeoutMs)*time.Millisecond)
		defer cancel()
	}
	req, err := http.NewRequestWithContext(ctx, a.Method, u.String(), body)
	if err != nil {
		return nil, ops.BadArgs("%v", err)
	}
	for k, v := range a.Headers {
		if strings.EqualFold(k, "host") {
			req.Host = v
			continue
		}
		req.Header.Set(k, v)
	}
	insecure := a.InsecureTLS == nil || *a.InsecureTLS
	resp, err := m.http.get(insecure, a.FollowRedirects).Do(req)
	if err != nil {
		return nil, mapErr(ctx, err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil && len(b) == 0 {
		return nil, mapErr(ctx, err)
	}
	truncated := int64(len(b)) > maxBody || err != nil
	if int64(len(b)) > maxBody {
		b = b[:maxBody]
	}
	hdr := make(map[string]string, len(resp.Header))
	for k, vs := range resp.Header {
		hdr[strings.ToLower(k)] = strings.Join(vs, ", ")
	}
	text, isText := asText(b, truncated)
	data, shrunk := ops.FitFrame(len(b), func(limit int) any {
		r := HTTPResult{Status: resp.StatusCode, Headers: hdr, Truncated: truncated || limit < len(b)}
		if isText {
			s := ops.TruncateUTF8(text, limit)
			r.Body = &s
		} else {
			s := base64.StdEncoding.EncodeToString(b[:min(limit, len(b))])
			r.BodyB64 = &s
		}
		return r
	})
	_ = shrunk
	return data, nil
}

// asText decides between body and body_b64: valid UTF-8 → text. A body cut
// by truncation in the middle of a rune is still text.
func asText(b []byte, truncated bool) (string, bool) {
	if utf8.Valid(b) {
		return string(b), true
	}
	if truncated {
		for cut := 1; cut <= 3 && cut <= len(b); cut++ {
			if utf8.Valid(b[:len(b)-cut]) {
				return string(b[:len(b)-cut]), true
			}
		}
	}
	return "", false
}
