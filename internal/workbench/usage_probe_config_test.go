//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
)

func usageProbeTestConfigDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("PIDECK_V2_PI_CONFIG", dir)
	return filepath.Join(dir, "usage-probes.json")
}

func usageProbeTestJSON(t *testing.T, raw string) any {
	t.Helper()
	value, err := usageProbeDecodeJSON([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func usageProbeTestEnabled() *bool { enabled := true; return &enabled }

func TestUsageProbeConfigPreservesUnknownAndLegacy(t *testing.T) {
	path := usageProbeTestConfigDir(t)
	original := `{"future":{"exact":9007199254740993},"providers":{"alpha":{"enabled":false,"apiKey":"old","future":{"nested":1}},"other":{"enabled":false,"future":"untouched"}},"probes":[{"match":{"baseUrlContains":["example.test"]},"request":{"path":"/wallet","skipBearer":true,"headers":{"Cookie":"test-cookie"}},"parse":{"kind":"balance","valuePath":"data.balance"},"future":7}]}`
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	config := usageProbeConfig{Enabled: usageProbeTestEnabled(), Template: "general", TimeoutSecs: 7}
	if err := saveUsageProbeConfig("alpha", config); err != nil {
		t.Fatal(err)
	}
	saved, exists, err := loadUsageProbeConfig("alpha")
	if err != nil || !exists || saved.TimeoutSecs != 7 || saved.Enabled == nil || !*saved.Enabled || saved.APIKey != "" {
		t.Fatalf("loaded=(%+v,%v,%v)", saved, exists, err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	doc := usageProbeTestJSON(t, string(data))
	for _, field := range []string{"future.exact", "providers.alpha.future.nested", "providers.other.future", "probes[0].future", "probes[0].request.headers.Cookie"} {
		if got, want := usageProbeGet(doc, field), usageProbeGet(usageProbeTestJSON(t, original), field); !usageProbeEquals(got, want) {
			t.Errorf("%s=%v want %v", field, got, want)
		}
	}
	if !strings.Contains(string(data), "9007199254740993") {
		t.Fatal("large unknown JSON number lost precision")
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("mode=%v err=%v", info, err)
		}
	}
}

func TestUsageProbeConfigRejectsInvalidWithoutOverwrite(t *testing.T) {
	path := usageProbeTestConfigDir(t)
	for _, raw := range []string{
		``, `null`, `{`, `{} {}`, `{"providers":[]}`, `{"probes":{}}`,
		`{"providers":{"a":{"enabled":null}}}`, `{"providers":{"a":{"enabled":"true"}}}`,
		`{"providers":{"a":{"timeoutSecs":0}}}`, `{"providers":{"a":{"timeoutSecs":1.5}}}`,
		`{"providers":{"a":{"intervalMinutes":1441}}}`, `{"providers":{"a":{"apiKey":12}}}`,
		`{"providers":{"a":{"template":"run-javascript"}}}`, `{"providers":{"a":{"baseUrl":"file:///private"}}}`,
		`{"providers":{"a":{"cookiePath":"//elsewhere.test"}}}`, `{"providers":{"a":{"enabled":true,"enabled":false}}}`,
		`{"probes":[{"match":{"baseUrlContains":["example.test"]},"request":{"path":"/wallet"},"parse":{"kind":"custom","resolver":"xai-billing"}}]}`,
	} {
		t.Run(strconv.Quote(raw), func(t *testing.T) {
			if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := saveUsageProbeConfig("target", usageProbeConfig{Template: "general"}); err == nil {
				t.Fatal("invalid document was overwritten")
			}
			got, err := os.ReadFile(path)
			if err != nil || string(got) != raw {
				t.Fatalf("file changed on rejected save: %q err=%v", got, err)
			}
		})
	}
}

func TestUsageProbeConfigConcurrentProviderWrites(t *testing.T) {
	usageProbeTestConfigDir(t)
	var workers sync.WaitGroup
	errors := make(chan error, 16)
	for i := 0; i < 16; i++ {
		workers.Add(1)
		go func(index int) {
			defer workers.Done()
			errors <- saveUsageProbeConfig("provider-"+strconv.Itoa(index), usageProbeConfig{Template: "general", TimeoutSecs: index + 1})
		}(i)
	}
	workers.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 16; i++ {
		config, ok, err := loadUsageProbeConfig("provider-" + strconv.Itoa(i))
		if err != nil || !ok || config.TimeoutSecs != i+1 {
			t.Fatalf("provider %d lost: %+v %v %v", i, config, ok, err)
		}
	}
}

func TestUsageProbeLegacyArrayIsReadOnlyUntilSave(t *testing.T) {
	path := usageProbeTestConfigDir(t)
	raw := `[{"match":{"baseUrlContains":["example.test"]},"request":{"path":"/wallet","method":"POST","body":{"query":"balance"}},"parse":{"kind":"credits","remainingPath":"data.left","scale":100},"future":9007199254740993}]`
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	probes, err := loadUsageProbeLegacy()
	if err != nil || len(probes) != 1 || probes[0].method != "POST" {
		t.Fatalf("legacy=%+v err=%v", probes, err)
	}
	if _, ok, err := loadUsageProbeConfig("a"); err != nil || ok {
		t.Fatalf("missing provider: ok=%v err=%v", ok, err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != raw {
		t.Fatalf("read changed legacy file: err=%v", err)
	}
	if err := saveUsageProbeConfig("a", usageProbeConfig{Template: "general"}); err != nil {
		t.Fatal(err)
	}
	got, _ = os.ReadFile(path)
	if !json.Valid(got) || !strings.Contains(string(got), "9007199254740993") {
		t.Fatalf("save lost legacy content: %s", got)
	}
}

func TestUsageProbeEffectiveDefaultsAndRecognition(t *testing.T) {
	provider := providerConfig{BaseURL: "https://api.deepseek.com", API: "openai-completions"}
	enabled, template, timeout, interval := effectiveUsageProbe(provider, usageProbeConfig{})
	if enabled || template != "deepseek-balance" || timeout != 10 || interval != 5 {
		t.Fatalf("effective=%v %q %d %d", enabled, template, timeout, interval)
	}
	zero := 0
	enabled, template, timeout, interval = effectiveUsageProbe(provider, usageProbeConfig{Enabled: usageProbeTestEnabled(), Template: "general", TimeoutSecs: 23, IntervalMinutes: &zero})
	if !enabled || template != "general" || timeout != 23 || interval != 0 {
		t.Fatalf("explicit=%v %q %d %d", enabled, template, timeout, interval)
	}
	for _, test := range []struct{ base, api, want string }{
		{"https://unknown.test/v1", "openai-completions", ""},
		{"https://opencode.ai/zen/v1", "openai-completions", "opencode-usage"},
		{"https://api.kimi.com/coding/v1", "anthropic-messages", "kimi-credits"},
		{"https://api.minimax.io/anthropic", "anthropic-messages", "minimax-plan"},
		{"https://chatgpt.com/backend-api", "openai-completions", ""},
		{"https://chatgpt.com/backend-api", "openai-codex-responses", "codex-usage"},
	} {
		if got := recognizedUsageTemplate(providerConfig{BaseURL: test.base, API: test.api}); got != test.want {
			t.Errorf("recognize %s/%s=%q want %q", test.base, test.api, got, test.want)
		}
	}
}
