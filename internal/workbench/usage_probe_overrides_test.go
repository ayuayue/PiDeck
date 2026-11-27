//go:build !js && !android && !ios

package workbench

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestUsageProbeGeneralCustomURLAndValuePath(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if r.URL.Path == "/v1/billing" {
			io.WriteString(w, `{"data":{"credit":7.25,"currency":"USD"}}`)
		} else {
			io.WriteString(w, `{"balance":8,"unit":"USD","data":{"credit":7.25,"currency":"USD"}}`)
		}
	}))
	defer server.Close()
	provider := providerConfig{BaseURL: server.URL + "/v1"}
	credential := providerModelCredential{Value: "test-key"}
	for _, test := range []struct {
		name, base, value, currency, wantPath, wantValue string
	}{
		{"full-endpoint", server.URL + "/v1/billing", "data.credit", "data.currency", "/v1/billing", "7.25"},
		{"base-override-without-path", server.URL + "/v1", "", "", "/v1/usage", "8.00"},
		{"value-override-without-base", "", "data.credit", "data.currency", "/v1/usage", "7.25"},
		{"dev-default", "", "", "", "/v1/usage", "8.00"},
	} {
		t.Run(test.name, func(t *testing.T) {
			config := usageProbeConfig{Enabled: usageProbeTestEnabled(), Template: "general", BaseURL: test.base, ValuePath: test.value, CurrencyPath: test.currency}
			result, err := queryProviderUsage(context.Background(), server.Client(), provider, credential, config)
			if err != nil || !strings.Contains(result.Summary, test.wantValue) || !strings.Contains(result.Summary, "USD") || paths[len(paths)-1] != test.wantPath {
				t.Fatalf("result=%+v path=%v want %s err=%v", result, paths, test.wantPath, err)
			}
		})
	}
}

func TestUsageProbeOverrideCredentialRejectsCommandAndResolvesEnvironment(t *testing.T) {
	var calls atomic.Int32
	client := &http.Client{Transport: usageProbeRoundTripper(func(req *http.Request) (*http.Response, error) {
		calls.Add(1)
		if req.Header.Get("Authorization") != "Bearer resolved-env-token" {
			t.Error("credential reference sent literally")
		}
		return usageProbeTestResponse(200, `{"balance":1,"unit":"USD"}`), nil
	})}
	t.Setenv("PIDECK_TEST_USAGE_TOKEN", "resolved-env-token")
	provider := providerConfig{BaseURL: "https://example.test/v1"}
	for _, ref := range []string{"$PIDECK_TEST_USAGE_TOKEN", "${PIDECK_TEST_USAGE_TOKEN}"} {
		config := usageProbeConfig{Enabled: usageProbeTestEnabled(), Template: "general", APIKey: ref}
		if _, err := queryProviderUsage(context.Background(), client, provider, providerModelCredential{Value: "fallback"}, config); err != nil {
			t.Fatalf("environment reference rejected: %v", err)
		}
	}
	calls.Store(0)
	t.Setenv("PIDECK_TEST_USAGE_MISSING", "")
	for _, ref := range []string{"!never-execute-this", "$PIDECK_TEST_USAGE_MISSING"} {
		config := usageProbeConfig{Enabled: usageProbeTestEnabled(), Template: "general", APIKey: ref}
		if _, err := queryProviderUsage(context.Background(), client, provider, providerModelCredential{Value: "fallback"}, config); err == nil {
			t.Fatalf("unsafe/unresolved credential accepted")
		}
	}
	if calls.Load() != 0 {
		t.Fatalf("unsafe/unresolved credentials made %d requests", calls.Load())
	}
}
