//go:build !js && !android && !ios

package workbench

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func providerTransferFixture(t *testing.T, contents string) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", dir)
	t.Setenv("PIDECK_V2_PI_CONFIG", filepath.Join(dir, "pi"))
	path := modelsJSONPath()
	if contents != "" {
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return path
}

func readProviderTransferFixture(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestProviderTransferUnknownMetadataRoundTrip(t *testing.T) {
	path := providerTransferFixture(t, `{"futureRoot":{"keep":true},"providers":{"untouched":{"models":[{"id":"other","future":true}]}}}`)
	input := `{"futureRoot":"not imported","providers":{"acme":{"api":"future-protocol","baseUrl":"https://example.invalid/v1","futureProvider":{"enabled":true},"models":[{"id":"one","name":"模型一","contextWindow":128000,"maxTokens":4096,"reasoning":true,"input":["text","audio"],"cost":{"input":1.25,"future":{"tier":2}},"compat":{"futureFlag":{"mode":"keep"}},"future":{"large":9007199254740993,"key":"metadata","maxOutputTokens":32,"tokenizer":"future","nested":[null,true,{"x":"y"}]}}]}}}`
	if err := importProviderConfigs(input, false); err != nil {
		t.Fatal(err)
	}
	exported, err := exportProviderConfigs([]string{"acme"}, true)
	if err != nil {
		t.Fatal(err)
	}
	want, err := decodeTransferObject(input)
	if err != nil {
		t.Fatal(err)
	}
	got, err := decodeTransferObject(exported)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !reflect.DeepEqual(got["providers"], want["providers"]) {
		t.Fatal("export lost unknown model or provider metadata")
	}
	if err := importProviderConfigs(exported, true); err != nil {
		t.Fatal(err)
	}
	root, err := decodeTransferObject(readProviderTransferFixture(t, path))
	if err != nil {
		t.Fatal(err)
	}
	providers := root["providers"].(map[string]any)
	if !reflect.DeepEqual(providers["acme"], want["providers"].(map[string]any)["acme"]) || providers["untouched"] == nil || root["futureRoot"].(map[string]any)["keep"] != true {
		t.Fatal("round trip discarded metadata, another provider, or local root fields")
	}
}

func TestProviderTransferPreviewAndConflictDoNotWrite(t *testing.T) {
	before := `{"futureRoot":true,"providers":{"acme":{"apiKey":"local-value","models":[{"id":"old"}]},"untouched":{"models":[]}}}`
	path := providerTransferFixture(t, before)
	input := `{"providers":{"z-new":{"models":[]},"acme":{"models":[{"id":"one"},{"id":"two"}]},"a-new":{"models":[{"id":"one"}]}}}`
	preview, err := previewProviderImport(input)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(preview.Providers, []string{"a-new", "acme", "z-new"}) || preview.Models != 3 || !reflect.DeepEqual(preview.Conflicts, []string{"acme"}) {
		t.Fatalf("unexpected preview: %+v", preview)
	}
	if got := readProviderTransferFixture(t, path); got != before {
		t.Fatal("preview changed the file")
	}
	if err := importProviderConfigs(input, false); err == nil {
		t.Fatal("conflicting import succeeded without replacement consent")
	}
	if got := readProviderTransferFixture(t, path); got != before {
		t.Fatal("conflict changed the file or partially imported a new provider")
	}
	if err := importProviderConfigs(input, true); err != nil {
		t.Fatal(err)
	}
	root, err := decodeTransferObject(readProviderTransferFixture(t, path))
	if err != nil {
		t.Fatal(err)
	}
	providers := root["providers"].(map[string]any)
	if root["futureRoot"] != true || len(providers) != 4 || providers["untouched"] == nil {
		t.Fatal("replacement lost unrelated data")
	}
	if _, exists := providers["acme"].(map[string]any)["apiKey"]; exists {
		t.Fatal("replacement merged omitted fields instead of replacing the selected provider")
	}
}

func TestProviderTransferMissingFilePreviewAndDevEnvelope(t *testing.T) {
	path := providerTransferFixture(t, "")
	envelope := `{"schemaVersion":1,"kind":"pideck-models-export","encrypted":false,"providers":{"acme":{"models":[{"id":"模型","future":true}]}}}`
	input := base64.StdEncoding.EncodeToString([]byte(envelope))
	preview, err := previewProviderImport(" \n" + input + "\n")
	if err != nil || !reflect.DeepEqual(preview.Providers, []string{"acme"}) || preview.Models != 1 || len(preview.Conflicts) != 0 {
		t.Fatalf("dev envelope preview failed: %+v, %v", preview, err)
	}
	if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
		t.Fatalf("preview created the configuration directory: %v", err)
	}
	if err := importProviderConfigs(input, false); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(readProviderTransferFixture(t, path), `"future": true`) {
		t.Fatal("dev import lost model metadata")
	}
	for _, envelope := range []string{
		`{"schemaVersion":2,"kind":"pideck-models-export","encrypted":false,"providers":{"acme":{"models":[]}}}`,
		`{"schemaVersion":1,"kind":"other","encrypted":false,"providers":{"acme":{"models":[]}}}`,
		`{"schemaVersion":1,"kind":"pideck-models-export","encrypted":true,"kdf":{},"cipher":{}}`,
		`{"schemaVersion":1,"kind":"pideck-models-export","encrypted":"false","providers":{"acme":{"models":[]}}}`,
	} {
		if _, err := previewProviderImport(base64.StdEncoding.EncodeToString([]byte(envelope))); err == nil {
			t.Fatal("accepted an unsupported or encrypted dev envelope")
		}
	}
}

func TestProviderTransferRejectsMalformedWithoutWriting(t *testing.T) {
	before := `{"providers":{"existing":{"models":[]}}}`
	path := providerTransferFixture(t, before)
	cases := []string{
		``, `null`, `[]`, `true`, `{}`, `{"acme":{"models":[]}}`,
		`{"providers":null}`, `{"providers":[]}`, `{"providers":{}}`,
		`{"providers":{"":{"models":[]}}}`, `{"providers":{"bad/id":{"models":[]}}}`,
		`{"providers":{" padded ":{"models":[]}}}`, `{"providers":{"中文":{"models":[]}}}`,
		`{"providers":{"acme":null}}`, `{"providers":{"acme":[]}}`,
		`{"providers":{"acme":{}}}`, `{"providers":{"acme":{"models":null}}}`,
		`{"providers":{"acme":{"models":{}}}}`, `{"providers":{"acme":{"models":[null]}}}`,
		`{"providers":{"acme":{"models":[{}]}}}`, `{"providers":{"acme":{"models":[{"id":1}]}}}`,
		`{"providers":{"acme":{"models":[{"id":" "}]}}}`,
		`{"providers":{"acme":{"models":[{"id":"one"},{"id":"one"}]}}}`,
		`{"providers":{"acme":{"api":false,"models":[]}}}`,
		`{"providers":{"acme":{"baseUrl":{},"models":[]}}}`,
		`{"providers":{"acme":{"apiKey":[],"models":[]}}}`,
		`{"providers":{"acme":{"headers":{"X-Test":1},"models":[]}}}`,
		`{"providers":{"acme":{"headers":{"X-Test":"bad\nheader"},"models":[]}}}`,
		`{"providers":{"acme":{"headers":null,"models":[]}}}`,
		`{"providers":{"acme":{"compat":[],"models":[]}}}`,
		`{"providers":{"acme":{"compat":{"supportsDeveloperRole":"yes"},"models":[]}}}`,
		`{"providers":{"acme":{"models":[{"id":"one","reasoning":"yes"}]}}}`,
		`{"providers":{"acme":{"models":[{"id":"one","input":"text"}]}}}`,
		`{"providers":{"acme":{"models":[{"id":"one","input":[1]}]}}}`,
		`{"providers":{"acme":{"models":[{"id":"one","contextWindow":-1}]}}}`,
		`{"providers":{"acme":{"models":[{"id":"one","maxTokens":1.5}]}}}`,
		`{"providers":{"acme":{"models":[{"id":"one","maxTokens":1.0000000000000000001}]}}}`,
		`{"providers":{"acme":{"models":[{"id":"one","maxTokens":-1e-999}]}}}`,
		`{"providers":{"acme":{"models":[{"id":"one","maxTokens":"10"}]}}}`,
		`{"providers":{"acme":{"models":[{"id":"one","cost":[]}]}}}`,
		`{"providers":{"acme":{"models":[{"id":"one","cost":{"input":-1}}]}}}`,
		`{"providers":{"acme":{"models":[{"id":"one","cost":{"input":1e999}}]}}}`,
		`{"providers":{"acme":{"models":[{"id":"one","cost":{"output":"1"}}]}}}`,
		`{"providers":{"acme":{"models":[],"future":{"duplicate":1,"duplicate":2}}}}`,
		`{"providers":{"acme":{"models":[]},"acme":{"models":[]}}}`,
		`{"providers":{"acme":{"models":[]}}} {}`,
		`{"providers":{"acme":{"models":[]}}} trailing`,
		strings.Repeat(" ", providerTransferLimit+1),
		`{"providers":{"acme":{"models":[],"future":` + strings.Repeat("[", 258) + `0` + strings.Repeat("]", 258) + `}}}`,
	}
	for i, input := range cases {
		if _, err := previewProviderImport(input); err == nil {
			t.Errorf("case %d: preview accepted malformed input", i)
		}
		if err := importProviderConfigs(input, true); err == nil {
			t.Errorf("case %d: import accepted malformed input", i)
		}
		if got := readProviderTransferFixture(t, path); got != before {
			t.Fatalf("case %d: rejected import changed the file", i)
		}
	}
}

func TestProviderTransferDefaultExportRedactsSecrets(t *testing.T) {
	before := `{"rootSecret":"not exported","providers":{"acme":{"api":"future-protocol","baseUrl":"https://example.invalid/v1","apiKey":"provider-value","headers":{"Authorization":"credential","Proxy-Authorization":"credential","X-Api-Key":"credential","X-Token":"credential","Cookie":"credential","X-Custom":"kept"},"oauth":{"clientSecret":"credential","access_token":"credential","clientId":"public"},"models":[{"id":"one","maxTokens":8192,"headers":{"X-Goog-Api-Key":"credential","X-Model":"kept"},"future":{"key":"metadata","maxOutputTokens":3,"tokenizer":"kept","nested":[{"refreshToken":"credential","shape":"kept"}]}}]},"unselected":{"models":[]}}}`
	path := providerTransferFixture(t, before)
	exported, err := exportProviderConfigs([]string{"acme"}, false)
	if err != nil {
		t.Fatal(err)
	}
	root, err := decodeTransferObject(exported)
	if err != nil {
		t.Fatal(err)
	}
	providers := root["providers"].(map[string]any)
	if len(root) != 1 || len(providers) != 1 || providers["unselected"] != nil {
		t.Fatal("export included unrelated root or provider data")
	}
	if strings.Contains(exported, "credential") || strings.Contains(exported, "provider-value") {
		t.Fatal("default export leaked a secret")
	}
	provider := providers["acme"].(map[string]any)
	model := provider["models"].([]any)[0].(map[string]any)
	future := model["future"].(map[string]any)
	if provider["baseUrl"] != "https://example.invalid/v1" || len(provider["headers"].(map[string]any)) != 1 || model["maxTokens"] != json.Number("8192") || future["key"] != "metadata" || future["maxOutputTokens"] != json.Number("3") || future["tokenizer"] != "kept" {
		t.Fatal("redaction discarded model, address, or non-secret metadata")
	}
	if err := importProviderConfigs(exported, true); err != nil {
		t.Fatal("redacted export is not importable:", err)
	}
	if err := os.WriteFile(path, []byte(before), 0600); err != nil {
		t.Fatal(err)
	}
	explicit, err := exportProviderConfigs([]string{"acme"}, true)
	if err != nil || !strings.Contains(explicit, "provider-value") || !strings.Contains(explicit, "credential") {
		t.Fatal("explicit secret export did not preserve credentials")
	}
	if readProviderTransferFixture(t, path) != before {
		t.Fatal("export changed the source file")
	}
	for _, ids := range [][]string{nil, {}, {"missing"}, {"bad/id"}} {
		if _, err := exportProviderConfigs(ids, false); err == nil {
			t.Fatal("export accepted an empty, missing, or invalid selection")
		}
	}
}
