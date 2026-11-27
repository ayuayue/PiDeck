//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProviderManagementRejectsDamagedFiles(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PIDECK_V2_PI_CONFIG", dir)
	path := filepath.Join(dir, "models.json")
	for _, body := range []string{`null`, `{"providers":[]}`, `{"providers":{"acme":null}}`, `{"providers":{"acme":{"models":"broken"}}}`} {
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		if err := updateProviderConnection(providerConfig{ID: "acme", BaseURL: "https://new.example/v1"}, nil, nil); err == nil {
			t.Fatalf("accepted malformed file %s", body)
		}
		raw, _ := os.ReadFile(path)
		if string(raw) != body {
			t.Fatal("damaged file was overwritten")
		}
	}
}

func TestProviderManagementPreservesExactJSONNumbers(t *testing.T) {
	for name, change := range map[string]func() error{
		"create":     func() error { return writeProviderConfig(providerConfig{ID: "other"}, true) },
		"connection": func() error { return updateProviderConnection(providerConfig{ID: "acme"}, nil, nil) },
		"model":      func() error { return writeProviderModel("acme", "chat", modelConfig{ID: "chat"}) },
		"advanced": func() error {
			cfg, err := readModelAdvanced("acme", "chat")
			if err != nil {
				return err
			}
			return writeModelAdvanced("acme", "chat", cfg)
		},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("PIDECK_V2_PI_CONFIG", dir)
			path := filepath.Join(dir, "models.json")
			body := `{"future":9007199254740993,"providers":{"acme":{"models":[{"id":"chat","cost":{"tiers":[{"inputTokensAbove":100,"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"future":9007199254740993}]}}]}}}`
			if err := os.WriteFile(path, []byte(body), 0600); err != nil {
				t.Fatal(err)
			}
			if err := change(); err != nil {
				t.Fatal(err)
			}
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Count(string(raw), "9007199254740993") != 2 {
				t.Fatalf("configuration save changed an unknown integer: %s", raw)
			}
		})
	}
}

func TestProviderModelManagementPreservesUnknownFields(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PIDECK_V2_PI_CONFIG", dir)
	body := `{"future":true,"providers":{"acme":{"api":"openai-completions","headers":{"X-Custom":"kept"},"models":[{"id":"old","extra":{"keep":true},"input":["text","audio","image"],"cost":{"input":1,"future":9},"compat":{"futureFlag":"kept"}},{"id":"other"}]}}}`
	if err := os.WriteFile(filepath.Join(dir, "models.json"), []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	model := modelConfig{ID: "new", Images: false, Cost: modelCost{Input: 2}}
	if err := writeProviderModel("acme", "old", model); err != nil {
		t.Fatal(err)
	}
	if err := writeProviderModel("acme", "", model); err == nil {
		t.Fatal("duplicate model silently replaced existing entry")
	}
	if err := writeProviderModel("acme", "missing", modelConfig{ID: "x"}); err == nil {
		t.Fatal("stale model was recreated")
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "models.json"))
	var root map[string]any
	_ = json.Unmarshal(raw, &root)
	p := root["providers"].(map[string]any)["acme"].(map[string]any)
	list := p["models"].([]any)
	entry := list[0].(map[string]any)
	if entry["id"] != "new" || entry["extra"] == nil || entry["cost"].(map[string]any)["future"] != float64(9) || entry["compat"].(map[string]any)["futureFlag"] != "kept" {
		t.Fatalf("lost unowned data: %s", raw)
	}
	inputs, _ := entry["input"].([]any)
	if len(inputs) != 2 || inputs[1] != "audio" {
		t.Fatalf("image toggle discarded non-image inputs: %v", inputs)
	}
	if err := deleteProviderModel("acme", "new"); err != nil {
		t.Fatal(err)
	}
	if got := readProviderConfigs()[0].Models; len(got) != 1 || got[0].ID != "other" {
		t.Fatalf("delete removed other model: %v", got)
	}
}

func TestProviderManagementCloneAndDelete(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PIDECK_V2_PI_CONFIG", dir)
	body := `{"future":true,"providers":{"acme":{"api":"openai-completions","oauth":{"clientId":"kept"},"models":[{"id":"one","future":true}]},"other":{"models":[]}}}`
	if err := os.WriteFile(filepath.Join(dir, "models.json"), []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	if err := cloneProviderConfig("acme", "copy"); err != nil {
		t.Fatal(err)
	}
	if err := cloneProviderConfig("acme", "other"); err == nil {
		t.Fatal("clone overwrote provider")
	}
	if err := deleteProviderConfig("acme"); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "models.json"))
	if strings.Contains(string(raw), `"acme"`) || !strings.Contains(string(raw), `"clientId"`) || !strings.Contains(string(raw), `"other"`) {
		t.Fatalf("clone/delete lost data: %s", raw)
	}
}

func TestProviderManagementBatchDeletePreservesUnselectedOverrides(t *testing.T) {
	path := writePiFile(t, "models.json", `{"providers":{"acme":{"models":[{"id":"one"},{"id":"two"},{"id":"three"}],"modelOverrides":{"one":{"headers":{"User-Agent":"one"}},"two":{"keep":true},"three":{"keep":true}}}}}`)
	before, _ := os.ReadFile(path)
	if err := deleteProviderModels("acme", []string{"one", "missing"}); err == nil {
		t.Fatal("stale batch accepted")
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("stale batch partially deleted models")
	}
	if err := deleteProviderModels("acme", []string{"one", "three"}); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	var root map[string]any
	json.Unmarshal(raw, &root)
	p := root["providers"].(map[string]any)["acme"].(map[string]any)
	overrides := p["modelOverrides"].(map[string]any)
	if len(p["models"].([]any)) != 1 || len(overrides) != 1 || overrides["two"] == nil {
		t.Fatalf("unselected model/override lost: %s", raw)
	}
}

func TestProviderManagementMergesBuiltinCatalog(t *testing.T) {
	configured := []providerConfig{{ID: "builtin", Models: []modelConfig{{ID: "custom"}, {ID: "shared", Name: "Override"}}}}
	catalog := []providerConfig{{ID: "builtin", API: "openai-responses", BaseURL: "https://example.invalid/v1", Builtin: true, Models: []modelConfig{{ID: "shared", Name: "Original"}, {ID: "catalog"}}}}
	list := mergeProviders(configured, catalog, nil)
	if len(list) != 1 || !list[0].Builtin || !list[0].Configured || list[0].API != "openai-responses" || len(list[0].Models) != 3 || list[0].Models[1].Name != "Override" {
		t.Fatalf("incorrect configured/catalog merge: %+v", list)
	}
}

func TestProviderModelDraftValidation(t *testing.T) {
	if err := validateModelNumbers("abc", "", "0", "", "", ""); err == nil {
		t.Fatal("invalid context silently became zero")
	}
	if err := validateModelNumbers("128000", "4096", "NaN", "", "", ""); err == nil {
		t.Fatal("accepted NaN cost")
	}
	if err := validateModelNumbers("128000", "4096", "1.25", "0", "", ""); err != nil {
		t.Fatal(err)
	}
}
