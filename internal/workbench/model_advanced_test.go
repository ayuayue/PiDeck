//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestModelAdvancedPreservesFieldsAndRejectsInvalidDraft(t *testing.T) {
	path := writePiFile(t, "models.json", `{"future":true,"providers":{"acme":{"models":[{"id":"chat","extra":"kept","cost":{"input":1,"future":true},"thinkingLevelMap":{"high":"custom-high","future":"wire"}}],"modelOverrides":{"chat":{"future":true,"headers":{"X-Test":"kept","User-Agent":"old"}}}}}}`)
	cfg, err := readModelAdvanced("acme", "chat")
	if err != nil {
		t.Fatal(err)
	}
	cfg.UserAgent = "Agent/2"
	cfg.ThinkingLevelMap["low"] = nil
	cfg.ThinkingLevelMap["xhigh"] = "xhigh"
	cfg.Tiers = []map[string]any{{"inputTokensAbove": float64(100000), "input": float64(2), "output": float64(4), "cacheRead": float64(0), "cacheWrite": float64(0), "future": "kept"}}
	if err = writeModelAdvanced("acme", "chat", cfg); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	var root map[string]any
	if err = json.Unmarshal(raw, &root); err != nil {
		t.Fatal(err)
	}
	p := root["providers"].(map[string]any)["acme"].(map[string]any)
	m := p["models"].([]any)[0].(map[string]any)
	over := p["modelOverrides"].(map[string]any)["chat"].(map[string]any)
	if root["future"] != true || m["extra"] != "kept" || m["cost"].(map[string]any)["future"] != true || over["future"] != true || over["headers"].(map[string]any)["X-Test"] != "kept" {
		t.Fatalf("unknown fields lost: %s", raw)
	}
	got, err := readModelAdvanced("acme", "chat")
	if err != nil || got.UserAgent != "Agent/2" || got.ThinkingLevelMap["high"] != "custom-high" || got.ThinkingLevelMap["future"] != "wire" || got.Tiers[0]["future"] != "kept" {
		t.Fatalf("round trip = %+v, %v", got, err)
	}
	cfg.Tiers[0]["input"] = -1.0
	if err = writeModelAdvanced("acme", "chat", cfg); err == nil {
		t.Fatal("accepted negative tier price")
	}
	after, _ := os.ReadFile(path)
	if string(after) != string(raw) {
		t.Fatal("invalid draft changed file")
	}
	cfg.Tiers = nil
	cfg.UserAgent = "injected\r\nheader"
	if writeModelAdvanced("acme", "chat", cfg) == nil {
		t.Fatal("accepted multiline user agent")
	}
}

func TestModelAdvancedResetUsesCatalog(t *testing.T) {
	path := writePiFile(t, "models.json", `{"providers":{"acme":{"models":[{"id":"chat","name":"Custom","contextWindow":100,"input":["text"],"cost":{"input":99,"tiers":[]},"thinkingLevelMap":{"high":null},"extra":"kept"}],"modelOverrides":{"chat":{"headers":{"User-Agent":"custom","X-Keep":"yes"}}}}}}`)
	catalog := `{"acme":{"models":[{"id":"chat","name":"Catalog Chat","api":"openai-completions","baseUrl":"https://example.invalid/v1","contextWindow":64000,"maxTokens":4096,"reasoning":true,"input":["text","image"],"cost":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0},"compat":{"supportsStore":false}}]}}`
	if err := os.WriteFile(filepath.Join(piConfigDir(), "models-store.json"), []byte(catalog), 0600); err != nil {
		t.Fatal(err)
	}
	if err := resetProviderModel("acme", "chat"); err != nil {
		t.Fatal(err)
	}
	models := readProviderConfigs()[0].Models
	if len(models) != 1 || models[0].Name != "Catalog Chat" || models[0].ContextWindow != 64000 || !models[0].Images || models[0].Cost.Input != 1 {
		t.Fatalf("reset = %+v", models)
	}
	cfg, err := readModelAdvanced("acme", "chat")
	if err != nil || cfg.UserAgent != "" || cfg.ThinkingLevelMap != nil || cfg.Tiers != nil {
		t.Fatalf("advanced overrides not reset: %+v %v", cfg, err)
	}
	raw, _ := os.ReadFile(path)
	var root map[string]any
	json.Unmarshal(raw, &root)
	p := root["providers"].(map[string]any)["acme"].(map[string]any)
	if p["models"].([]any)[0].(map[string]any)["extra"] != "kept" || p["modelOverrides"].(map[string]any)["chat"].(map[string]any)["headers"].(map[string]any)["X-Keep"] != "yes" {
		t.Fatal("reset lost unrelated fields")
	}
}

func TestModelThinkingDefaultsAndMigration(t *testing.T) {
	path := writePiFile(t, "settings.json", `{"future":{"keep":true},"modelThinkingLevels":{"other/chat":"future-level"}}`)
	if err := saveModelThinkingDefault("acme", "chat", "high"); err != nil {
		t.Fatal(err)
	}
	if got, err := readModelThinkingDefault("acme", "chat"); err != nil || got != "high" {
		t.Fatalf("default = %q %v", got, err)
	}
	if err := migrateModelThinkingReferences("acme", "chat", "renamed"); err != nil {
		t.Fatal(err)
	}
	if got, _ := readModelThinkingDefault("acme", "chat"); got != "" {
		t.Fatal("old default remains")
	}
	if got, _ := readModelThinkingDefault("acme", "renamed"); got != "high" {
		t.Fatal("renamed default missing")
	}
	if err := migrateModelThinkingReferences("acme", "renamed", ""); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	var root map[string]any
	json.Unmarshal(raw, &root)
	if root["future"] == nil || root["modelThinkingLevels"].(map[string]any)["other/chat"] != "future-level" {
		t.Fatalf("unrelated settings lost: %s", raw)
	}
	broken := []byte(`{"modelThinkingLevels":[]}`)
	os.WriteFile(path, broken, 0600)
	if saveModelThinkingDefault("acme", "chat", "high") == nil {
		t.Fatal("accepted malformed thinking table")
	}
	after, _ := os.ReadFile(path)
	if string(after) != string(broken) {
		t.Fatal("rewrote damaged settings")
	}
}
