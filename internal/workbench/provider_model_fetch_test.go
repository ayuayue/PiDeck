//go:build !js && !android && !ios

package workbench

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestParseProviderModelListAndCatalogMetadata(t *testing.T) {
	got, err := parseProviderModelList([]byte(`{"data":[{"id":"model-z","name":"Zulu"},{"id":"model-a","name":"Alpha"}]}`), "openai-completions")
	if err != nil {
		t.Fatal(err)
	}
	got = mergeCatalogModels("acme", got, []providerConfig{{ID: "acme", Models: []modelConfig{{ID: "model-a", ContextWindow: 64000, MaxTokens: 4096, Reasoning: true, Images: true, Cost: modelCost{Input: 1}}}}})
	if len(got) != 2 || got[0].ID != "model-a" || got[1].ID != "model-z" {
		t.Fatalf("models = %+v, want alpha then zulu", got)
	}
	if got[0].ContextWindow != 64000 || got[0].MaxTokens != 4096 || !got[0].Reasoning || !got[0].Images || got[0].Cost.Input != 1 {
		t.Fatalf("catalog metadata not filled: %+v", got[0])
	}
	google, err := parseProviderModelList([]byte(`{"models":[{"name":"models/gemini-2","displayName":"Gemini 2","inputTokenLimit":32768,"outputTokenLimit":2048}]}`), "google-generative-ai")
	if err != nil || len(google) != 1 || google[0].ID != "gemini-2" || google[0].Name != "Gemini 2" || google[0].ContextWindow != 32768 || google[0].MaxTokens != 2048 {
		t.Fatalf("google models = %+v, %v", google, err)
	}
}

func TestProviderModelEndpointsValidateAndBuild(t *testing.T) {
	cases := []struct {
		name string
		base string
		api  string
		want []string
	}{
		{"openai", "https://example.test/v1", "openai-completions", []string{"https://example.test/v1/models"}},
		{"anthropic", "https://example.test/v1", "anthropic-messages", []string{"https://example.test/v1/models", "https://example.test/models"}},
		{"google", "https://example.test", "google-generative-ai", []string{"https://example.test/v1beta/models?key=secret"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			endpoints, err := providerModelEndpoints(tc.base, tc.api, "secret")
			if err != nil {
				t.Fatal(err)
			}
			got := make([]string, len(endpoints))
			for i := range endpoints {
				got[i] = endpoints[i].URL
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("endpoints = %v, want %v", got, tc.want)
			}
		})
	}
	for _, bad := range []string{"file:///tmp/models", "https://user:secret@example.test/v1", "https:///missing-host"} {
		if _, err := providerModelEndpoints(bad, "openai-completions", "secret"); err == nil || strings.Contains(err.Error(), "secret") {
			t.Errorf("invalid URL %q: err = %v", bad, err)
		}
	}
}

func TestFetchProviderModelsUsesSafeAuthAndErrors(t *testing.T) {
	var sawBearer, sawAPIKey bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawBearer = r.Header.Get("Authorization") == "Bearer secret-token"
		sawAPIKey = r.Header.Get("x-api-key") != ""
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"chat","name":"Chat"}]}`))
	}))
	defer server.Close()
	cfg := providerConfig{ID: "acme", API: "openai-completions", BaseURL: server.URL + "/v1"}
	models, err := fetchProviderModelList(context.Background(), &http.Client{}, cfg,
		providerModelCredential{Value: "secret-token", Bearer: true}, nil)
	if err != nil || len(models) != 1 || !sawBearer || sawAPIKey {
		t.Fatalf("models = %+v, err = %v, bearer=%v x-api-key=%v", models, err, sawBearer, sawAPIKey)
	}
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"secret-token leaked by provider"}`))
	})
	_, err = fetchProviderModelList(context.Background(), &http.Client{}, cfg,
		providerModelCredential{Value: "secret-token", Bearer: true}, nil)
	if err == nil || strings.Contains(err.Error(), "secret-token") || strings.Contains(err.Error(), server.URL) {
		t.Fatalf("request error leaked response or URL: %v", err)
	}
}

func TestAppendSelectedProviderModelsKeepsExistingOrder(t *testing.T) {
	existing := []modelConfig{{ID: "old-z", Name: "Zulu"}, {ID: "old-a", Name: "Alpha"}}
	fetched := []modelConfig{{ID: "new-z", Name: "Zebra"}, {ID: "old-z", Name: "Replacement"}, {ID: "new-a", Name: "Aardvark"}}
	got, added := appendSelectedProviderModels(existing, fetched, map[string]bool{"new-z": true, "old-z": true, "new-a": true})
	ids := make([]string, len(got))
	for i := range got {
		ids[i] = got[i].ID
	}
	if added != 2 || !reflect.DeepEqual(ids, []string{"old-z", "old-a", "new-a", "new-z"}) {
		t.Fatalf("ids=%v added=%d, want existing order followed by sorted additions", ids, added)
	}
}

func TestParsePiAuthProviders(t *testing.T) {
	providers, err := parsePiAuthProviders([]byte(`[
		{"id":"oauth","name":"OAuth Provider","oauth":{"name":"Browser","loginLabel":"Sign in"}},
		{"id":"key","name":"Key Provider","apiKey":{"name":"API key","login":true}},
		{"id":"unsupported","name":"Unsupported"},
		{"id":"","oauth":{"name":"invalid"}}
	]`))
	if err != nil || len(providers) != 2 || providers[0].ID != "key" || providers[0].APIKey == nil || !providers[0].APIKey.Login || providers[1].ID != "oauth" || providers[1].OAuth == nil || providers[1].OAuth.LoginLabel != "Sign in" {
		t.Fatalf("providers = %+v, err = %v", providers, err)
	}
}

func TestProviderModelSortUsesNameThenID(t *testing.T) {
	models := []modelConfig{{ID: "z", Name: "Same"}, {ID: "b", Name: "Beta"}, {ID: "a", Name: "Same"}}
	sortProviderModelsAlphabetically(models)
	ids := []string{models[0].ID, models[1].ID, models[2].ID}
	if !reflect.DeepEqual(ids, []string{"b", "a", "z"}) {
		t.Fatalf("model order = %v", ids)
	}
}
