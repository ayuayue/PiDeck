//go:build !js && !android && !ios

package workbench

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type usageProbeRoundTripper func(*http.Request) (*http.Response, error)

func (fn usageProbeRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) { return fn(req) }

func usageProbeTestResponse(code int, raw string) *http.Response {
	return &http.Response{StatusCode: code, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(raw))}
}

func TestUsageProbeDeclarativeHTTP(t *testing.T) {
	for _, test := range []struct {
		name, path, response, summary string
		config                        usageProbeConfig
		check                         func(*testing.T, *http.Request)
	}{
		{"general", "/v1/usage", `{"balance":"12.34","unit":"USD"}`, "12.34", usageProbeConfig{Template: "general"}, func(t *testing.T, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer custom-key" {
				t.Errorf("missing explicit API key")
			}
		}},
		{"newapi", "/api/user/self", `{"data":{"quota":750000,"used_quota":"250000"}}`, "1.50", usageProbeConfig{Template: "newapi", AccessToken: "panel-token", UserID: "42"}, func(t *testing.T, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer panel-token" || r.Header.Get("New-Api-User") != "42" {
				t.Errorf("New API auth headers incorrect")
			}
		}},
		{"cookie", "/api/wallet", `{"data":{"wallets":[{"balance":"9.25","currency":"CNY"}]}}`, "9.25", usageProbeConfig{Template: "cookie", Cookie: "session=test", CookiePath: "/api/wallet", ValuePath: "data.wallets[0].balance", CurrencyPath: "data.wallets[0].currency"}, func(t *testing.T, r *http.Request) {
			if r.Header.Get("Cookie") != "session=test" || r.Header.Get("Authorization") != "" {
				t.Errorf("cookie query leaked Bearer or lost Cookie")
			}
		}},
		{"sub2api", "/v1/usage", `{"type":"subscription","remaining":-1,"subscription":{"weekly_limit_usd":10,"weekly_usage_usd":2}}`, "2.00", usageProbeConfig{Template: "sub2api"}, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != test.path || r.Method != http.MethodGet {
					t.Errorf("request=%s %s want GET %s", r.Method, r.URL.Path, test.path)
					w.WriteHeader(404)
					return
				}
				if test.check != nil {
					test.check(t, r)
				}
				io.WriteString(w, test.response)
			}))
			defer server.Close()
			config := test.config
			config.Enabled, config.APIKey, config.BaseURL = usageProbeTestEnabled(), "custom-key", server.URL+"/v1"
			result, err := queryProviderUsage(context.Background(), server.Client(), providerConfig{ID: "sample", BaseURL: "https://unused.test/v1"}, providerModelCredential{Value: "provider-key"}, config)
			if err != nil || !strings.Contains(result.Summary, test.summary) || len(result.Details) == 0 || result.At.IsZero() {
				t.Fatalf("result=%+v err=%v", result, err)
			}
		})
	}
}

func TestUsageProbeHTTPRejectsUnsafeResponsesAndRedirect(t *testing.T) {
	var redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirected.Add(1)
		io.WriteString(w, `{"balance":9000}`)
	}))
	defer target.Close()
	secret := "private-key-and-response"
	for _, test := range []struct {
		name, body string
		status     int
		redirect   bool
	}{
		{"unauthorized", secret, 401, false}, {"html", "<html>" + secret + "</html>", 200, false},
		{"oversized", strings.Repeat(" ", usageProbeMaxResponse) + `{"balance":99}`, 200, false},
		{"empty-shape", `{"enabled":true}`, 200, false}, {"duplicate", `{"balance":1,"balance":2}`, 200, false},
		{"redirect", "", 302, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if test.redirect {
					w.Header().Set("Location", target.URL+"/?key="+secret)
				}
				w.WriteHeader(test.status)
				io.WriteString(w, test.body)
			}))
			defer server.Close()
			client := server.Client()
			var callerRedirects atomic.Int32
			client.CheckRedirect = func(*http.Request, []*http.Request) error { callerRedirects.Add(1); return nil }
			_, err := queryProviderUsage(context.Background(), client, providerConfig{BaseURL: server.URL + "/v1"}, providerModelCredential{Value: secret}, usageProbeConfig{Enabled: usageProbeTestEnabled(), Template: "general"})
			if err == nil || strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), server.URL) {
				t.Fatalf("unsafe error=%v", err)
			}
			if callerRedirects.Load() != 0 || client.CheckRedirect == nil {
				t.Fatal("caller's redirect policy changed or was used")
			}
		})
	}
	if redirected.Load() != 0 {
		t.Fatalf("sent credentials to redirect destination: %d requests", redirected.Load())
	}
}

func TestUsageProbeContextAndTransportErrorsAreRedacted(t *testing.T) {
	secret := "secret-token-in-url-and-error"
	client := &http.Client{Transport: usageProbeRoundTripper(func(req *http.Request) (*http.Response, error) {
		return nil, errors.New("network: " + secret)
	})}
	provider := providerConfig{BaseURL: "https://example.test/v1"}
	config := usageProbeConfig{Enabled: usageProbeTestEnabled(), Template: "general"}
	_, err := queryProviderUsage(context.Background(), client, provider, providerModelCredential{Value: secret}, config)
	if err == nil || strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "example.test") {
		t.Fatalf("transport error=%v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var calls atomic.Int32
	client.Transport = usageProbeRoundTripper(func(req *http.Request) (*http.Response, error) {
		calls.Add(1)
		return usageProbeTestResponse(200, `{"balance":1}`), nil
	})
	if _, err := queryProviderUsage(ctx, client, provider, providerModelCredential{Value: secret}, config); err == nil || calls.Load() != 0 {
		t.Fatalf("canceled context err=%v calls=%d", err, calls.Load())
	}
	var deadline time.Time
	client.Transport = usageProbeRoundTripper(func(req *http.Request) (*http.Response, error) {
		got, ok := req.Context().Deadline()
		if !ok || time.Until(got) > 11*time.Second {
			t.Errorf("missing total timeout: %v %v", got, ok)
		}
		if deadline.IsZero() {
			deadline = got
		} else if !deadline.Equal(got) {
			t.Error("timeout was reset between fallback attempts")
		}
		calls.Add(1)
		if strings.Contains(req.URL.Path, "/v1/") {
			return usageProbeTestResponse(404, ""), nil
		}
		return usageProbeTestResponse(200, `{"balance":1}`), nil
	})
	provider.BaseURL = "https://example.test"
	if _, err := queryProviderUsage(context.Background(), client, provider, providerModelCredential{Value: secret}, config); err != nil || calls.Load() != 2 {
		t.Fatalf("fallback err=%v calls=%d", err, calls.Load())
	}
}

func TestUsageProbeMissingSettingsAndDisabledNeverRequest(t *testing.T) {
	var calls atomic.Int32
	client := &http.Client{Transport: usageProbeRoundTripper(func(req *http.Request) (*http.Response, error) {
		calls.Add(1)
		return usageProbeTestResponse(200, `{"balance":1}`), nil
	})}
	for _, config := range []usageProbeConfig{
		{Template: "general"},
		{Enabled: usageProbeTestEnabled(), Template: "general"},
		{Enabled: usageProbeTestEnabled(), Template: "newapi", AccessToken: "token"},
		{Enabled: usageProbeTestEnabled(), Template: "cookie", Cookie: "session=x"},
		{Enabled: usageProbeTestEnabled(), Template: "volcengine", AccessKeyID: "ak"},
	} {
		if _, err := queryProviderUsage(context.Background(), client, providerConfig{BaseURL: "https://example.test"}, providerModelCredential{}, config); err == nil {
			t.Fatalf("invalid query accepted for template %q", config.Template)
		}
	}
	if calls.Load() != 0 {
		t.Fatalf("invalid settings made %d requests", calls.Load())
	}
}

func TestUsageProbeLegacyCookieHTTP(t *testing.T) {
	path := usageProbeTestConfigDir(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "legacy=test" || r.Header.Get("Authorization") != "" || r.URL.Path != "/wallet" || r.Method != "POST" {
			t.Errorf("legacy request %s %s headers=%v", r.Method, r.URL.Path, r.Header)
		}
		io.WriteString(w, `{"data":{"remaining":"1234"}}`)
	}))
	defer server.Close()
	raw := `{"probes":[{"match":{"baseUrlContains":["127.0.0.1"]},"request":{"path":"/wallet","rootPath":true,"skipBearer":true,"method":"POST","headers":{"Cookie":"legacy=test"},"body":{"lookup":"balance"}},"parse":{"kind":"credits","remainingPath":"data.remaining","scale":100}}]}`
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := queryProviderUsage(context.Background(), server.Client(), providerConfig{BaseURL: server.URL + "/v1", API: "anthropic-messages"}, providerModelCredential{}, usageProbeConfig{Enabled: usageProbeTestEnabled()})
	if err != nil || !strings.Contains(result.Summary, "12.34") {
		t.Fatalf("legacy result=%+v err=%v", result, err)
	}
}

func TestUsageProbeXAIHandshakeAndHeaderSubstitution(t *testing.T) {
	usageProbeTestConfigDir(t)
	var paths []string
	client := &http.Client{Transport: usageProbeRoundTripper(func(req *http.Request) (*http.Response, error) {
		paths = append(paths, req.URL.Path)
		if req.URL.Host != "cli-chat-proxy.grok.com" || req.Header.Get("Authorization") != "Bearer xai-test" || req.Header.Get("X-XAI-Token-Auth") != "xai-grok-cli" {
			t.Error("xAI request origin/auth mismatch")
		}
		if req.URL.Path == "/v1/user" {
			return usageProbeTestResponse(200, `{"userId":"test-user"}`), nil
		}
		if req.Header.Get("x-userid") != "test-user" {
			t.Error("preflight user ID missing")
		}
		return usageProbeTestResponse(200, `{"config":{"creditUsagePercent":25}}`), nil
	})}
	result, err := queryProviderUsage(context.Background(), client, providerConfig{BaseURL: "https://api.x.ai/v1"}, providerModelCredential{Value: "xai-test", Bearer: true}, usageProbeConfig{Enabled: usageProbeTestEnabled()})
	if err != nil || len(paths) != 2 || !strings.Contains(result.Summary, "25.00") {
		t.Fatalf("xAI result=%+v paths=%v err=%v", result, paths, err)
	}
	headers := usageProbeHeaders(usageProbeCandidate{headers: map[string]string{"authorization": "{{ APIKEY }}"}}, "literal-$1")
	if headers.Get("Authorization") != "literal-$1" {
		t.Fatalf("placeholder replacement interpreted credentials: %v", headers)
	}
}
