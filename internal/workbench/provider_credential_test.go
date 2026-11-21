//go:build !js && !android && !ios

package workbench

// Checks where a provider's credential comes from, which providers the
// settings page lists, and the fields the model editor writes back.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writePiFile puts one of pi's own files in the test's config folder.
func writePiFile(t *testing.T, name, body string) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("PIDECK_LITE_PI_CONFIG", dir)
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestProviderCredentialOrder checks the credential the settings page
// names is the one pi resolves: auth.json, then models.json, then the
// environment.
func TestProviderCredentialOrder(t *testing.T) {
	t.Setenv("ACME_KEY", "from-env")

	literal := &authEntry{Provider: "acme", Type: "api_key", Hint: "…9876", Source: keyLiteral}
	if got := credentialOf("acme", literal, nil); got.Kind != credentialAuth || got.Detail != "…9876" || !got.Ready {
		t.Fatalf("stored key = %+v", got)
	}

	viaEnv := &authEntry{Provider: "acme", Type: "api_key", Source: keyEnv, Name: "NOT_SET_ANYWHERE"}
	if got := credentialOf("acme", viaEnv, nil); got.Detail != "$NOT_SET_ANYWHERE" || got.Ready {
		t.Fatalf("unset variable = %+v", got)
	}

	cfg := &providerConfig{ID: "acme", APIKey: "$ACME_KEY"}
	if got := credentialOf("acme", nil, cfg); got.Kind != credentialModels || got.Detail != "$ACME_KEY" || !got.Ready {
		t.Fatalf("models.json variable = %+v", got)
	}

	plain := "sk-" + "test-1234"
	cfg = &providerConfig{ID: "acme", APIKey: plain}
	if got := credentialOf("acme", nil, cfg); got.Kind != credentialModels || got.Detail != maskKey(plain) || !got.Ready {
		t.Fatalf("models.json literal = %+v", got)
	}

	// A stored entry wins over the provider's own key.
	cfg = &providerConfig{ID: "acme", APIKey: plain}
	if got := credentialOf("acme", literal, cfg); got.Kind != credentialAuth {
		t.Fatalf("stored entry should win: %+v", got)
	}

	t.Setenv("OPENROUTER_API_KEY", "sk-or")
	if got := credentialOf("openrouter", nil, nil); got.Kind != credentialEnv || got.Detail != "OPENROUTER_API_KEY" || !got.Ready {
		t.Fatalf("environment = %+v", got)
	}

	if got := credentialOf("nobody", nil, nil); got.Kind != "" {
		t.Fatalf("no credential = %+v", got)
	}
}

// TestOAuthEntryDetail checks an OAuth entry keeps its lifetime and
// refresh token, and that an api key entry keeps its source.
func TestOAuthEntryDetail(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	body := `{
  "anthropic": {"type": "api_key", "key": "$ANTHROPIC_KEY", "env": {"B": "2", "A": "1"}},
  "openai": {"type": "oauth", "access": "abcd1234", "refresh": "ref", "expires": 1700000120000}
}`
	writePiFile(t, "auth.json", body)
	entries, err := readAuthEntries()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v", entries)
	}
	key := entries[0]
	if key.Provider != "anthropic" || key.Source != keyEnv || key.Name != "ANTHROPIC_KEY" ||
		len(key.Env) != 2 || key.Env[0] != "A" || key.Env[1] != "B" || !key.Editable {
		t.Fatalf("api key entry = %+v", key)
	}
	oauth := entries[1]
	if oauth.Type != "oauth" || !oauth.Refreshable || oauth.Expires != 1700000120000 || oauth.Editable {
		t.Fatalf("oauth entry = %+v", oauth)
	}
	if got := authLifetime(oauth.Expires, now); got != "剩余 2m" {
		t.Fatalf("lifetime = %q", got)
	}
	if got := authLifetime(now.UnixMilli()-90_000, now); got != "已过期 1m" {
		t.Fatalf("expired = %q", got)
	}
	if got := authLifetime(0, now); got != "" {
		t.Fatalf("no expiry = %q", got)
	}
}

// TestMergeProviders checks the settings page lists models.json's
// providers, pi's catalog's, and any provider auth.json names, with each
// one's credential.
func TestMergeProviders(t *testing.T) {
	writePiFile(t, "models-store.json", `{
  "openrouter": {"models": [
    {"id": "or-1", "api": "openai-completions", "baseUrl": "https://openrouter.ai/api/v1"},
    {"id": "or-2", "api": "openai-completions"}
  ]}
}`)
	mergeKey := "sk-" + "provider-9876"
	cfgs := []providerConfig{{ID: "acme", API: "openai-completions", BaseURL: "https://acme/v1",
		APIKey: mergeKey, Models: []modelConfig{{ID: "a1"}, {ID: "a2"}, {ID: "a3"}}}}
	catalog := readCatalogProviders()
	if len(catalog) != 1 || !catalog[0].Builtin || len(catalog[0].Models) != 2 || catalog[0].API != "openai-completions" {
		t.Fatalf("catalog = %+v", catalog)
	}
	entries := []authEntry{{Provider: "stored", Type: "api_key", Hint: "…7777", Source: keyLiteral}}
	list := mergeProviders(cfgs, catalog, entries)
	if len(list) != 3 {
		t.Fatalf("providers = %+v", list)
	}
	byID := map[string]providerInfo{}
	for _, p := range list {
		byID[p.ID] = p
	}
	if p := byID["acme"]; p.Builtin || !p.Configured || len(p.Models) != 3 || p.Credential.Kind != credentialModels || p.Credential.Detail != maskKey(mergeKey) {
		t.Fatalf("acme = %+v", p)
	}
	if p := byID["openrouter"]; !p.Builtin || p.Configured || len(p.Models) != 2 || p.BaseURL != "https://openrouter.ai/api/v1" {
		t.Fatalf("openrouter = %+v", p)
	}
	if p := byID["stored"]; p.Builtin || p.Configured || len(p.Models) != 0 || p.Credential.Kind != credentialAuth {
		t.Fatalf("stored = %+v", p)
	}
}

// TestModelEntryFields checks the editor writes the fields it shows and
// keeps the rest of the entry, compat included.
func TestModelEntryFields(t *testing.T) {
	path := writePiFile(t, "models.json", `{"providers":{"acme":{"api":"openai-completions",
		"models":[{"id":"m1","note":"keep","compat":{"supportsStore":true,"cacheControlFormat":"anthropic"}}]}}}`)
	err := saveProviderModels("acme", []modelConfig{{
		ID: "m1", Name: "One", ContextWindow: 128000, MaxTokens: 8192, Reasoning: true, Images: true,
		Cost:   modelCost{Input: 0.15, Output: 0.6, CacheRead: 0.003},
		Compat: map[string]bool{"supportsStore": false, "supportsReasoningEffort": true},
	}})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var root struct {
		Providers map[string]struct {
			Models []map[string]any `json:"models"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(raw, &root); err != nil {
		t.Fatalf("models.json = %s", raw)
	}
	entry := root.Providers["acme"].Models[0]
	if entry["note"] != "keep" {
		t.Fatalf("unknown field lost: %+v", entry)
	}
	compat, _ := entry["compat"].(map[string]any)
	if compat["supportsStore"] != false || compat["supportsReasoningEffort"] != true {
		t.Fatalf("compat = %+v", compat)
	}
	if compat["cacheControlFormat"] != "anthropic" {
		t.Fatalf("a flag the editor does not show was dropped: %+v", compat)
	}
	input, _ := entry["input"].([]any)
	if len(input) != 2 || input[1] != "image" {
		t.Fatalf("input = %+v", entry["input"])
	}
	cost, _ := entry["cost"].(map[string]any)
	if cost["input"] != 0.15 || cost["output"] != 0.6 || cost["cacheWrite"] != float64(0) {
		t.Fatalf("cost = %+v", cost)
	}
	if got := intField(entry["contextWindow"]); got != 128000 {
		t.Fatalf("contextWindow = %+v", entry["contextWindow"])
	}

	// Clearing the price and the images leaves neither behind.
	err = saveProviderModels("acme", []modelConfig{{ID: "m1", Name: "One",
		Compat: map[string]bool{"supportsStore": false, "supportsReasoningEffort": true}}})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(path)
	root.Providers = nil
	if err := json.Unmarshal(raw, &root); err != nil {
		t.Fatalf("models.json = %s", raw)
	}
	entry = root.Providers["acme"].Models[0]
	if _, ok := entry["cost"]; ok {
		t.Fatalf("cost stayed: %+v", entry)
	}
	if _, ok := entry["input"]; ok {
		t.Fatalf("input stayed: %+v", entry)
	}
}

// TestCompatSuggestion words the catalog's advice for the flags the entry
// leaves alone.
func TestCompatSuggestion(t *testing.T) {
	suggest := map[string]bool{"supportsStore": true, "supportsDeveloperRole": false}
	if got := compatSuggestion(suggest, nil); got != "supportsDeveloperRole=false supportsStore=true" {
		t.Fatalf("suggestion = %q", got)
	}
	if got := compatSuggestion(suggest, map[string]bool{"supportsStore": true, "supportsDeveloperRole": false}); got != "" {
		t.Fatalf("agreed suggestion = %q", got)
	}
	if got := compatSuggestion(nil, nil); got != "" {
		t.Fatalf("empty suggestion = %q", got)
	}
}
