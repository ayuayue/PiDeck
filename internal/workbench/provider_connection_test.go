//go:build !js && !android && !ios

package workbench

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestManagedProviderProtocolChecks(t *testing.T) {
	for _, tt := range []struct{ api, path, header, value string }{{"openai-completions", "/v1/chat/completions", "Authorization", "Bearer fixture-key"}, {"openai-responses", "/v1/responses", "Authorization", "Bearer fixture-key"}, {"anthropic-messages", "/v1/messages", "x-api-key", "fixture-key"}, {"google-generative-ai", "/v1beta/models/chat:generateContent", "", ""}} {
		t.Run(tt.api, func(t *testing.T) {
			called := false
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				if r.Method != "POST" || r.URL.Path != tt.path {
					t.Errorf("request %s %s, want POST %s", r.Method, r.URL.Path, tt.path)
				}
				if tt.header != "" && r.Header.Get(tt.header) != tt.value {
					t.Errorf("missing protocol credential")
				}
				if tt.api == "google-generative-ai" && r.URL.Query().Get("key") != "fixture-key" {
					t.Error("missing Google key")
				}
				if r.Header.Get("X-Client") != "fixture" {
					t.Error("custom headers not sent")
				}
				w.Write([]byte(`{"ok":true}`))
			}))
			defer server.Close()
			cfg := providerConfig{API: tt.api, BaseURL: server.URL + "/v1", Headers: map[string]string{"X-Client": "fixture"}}
			if _, err := testProviderModelWith(context.Background(), server.Client(), cfg, "chat", providerModelCredential{Value: "fixture-key"}); err != nil {
				t.Fatal(err)
			}
			if !called {
				t.Fatal("no request")
			}
		})
	}
}

func TestManagedProviderChecksRejectRemoteErrorsAndRedirects(t *testing.T) {
	redirected := false
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected = true }))
	defer sink.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			http.Redirect(w, r, sink.URL, http.StatusFound)
			return
		}
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`fixture-secret echoed in remote error`))
	}))
	defer server.Close()
	cfg := providerConfig{API: "openai-completions", BaseURL: server.URL + "/v1"}
	credential := providerModelCredential{Value: "fixture-secret"}
	if _, err := testProviderConnectionWith(context.Background(), server.Client(), cfg, credential); err == nil {
		t.Fatal("redirect counted as successful connection")
	}
	if redirected {
		t.Fatal("followed redirect with provider credential")
	}
	if _, err := testProviderModelWith(context.Background(), server.Client(), cfg, "chat", credential); err == nil || strings.Contains(err.Error(), "fixture-secret") {
		t.Fatalf("remote rejection not redacted: %v", err)
	}
}
