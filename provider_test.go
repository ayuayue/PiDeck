package main

// Checks for reading and writing pi's provider settings, resolving a
// key, and the connection test's answers.

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/nsgotest"
)

// TestReadAndSaveProviderConfig checks only the three fields are written
// back and the rest of models.json survives.
func TestReadAndSaveProviderConfig(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PIDECK_LITE_PI_CONFIG", dir)
	body := `{
  "providers": {
    "acme": {
      "api": "openai-completions",
      "baseUrl": "https://old.example/v1",
      "apiKey": "old-key",
      "compat": {"supportsDeveloperRole": false},
      "models": [
        {"id": "acme-1", "name": "Acme One", "contextWindow": 128000, "maxTokens": 8192, "reasoning": true}
      ]
    }
  }
}`
	path := filepath.Join(dir, "models.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	cfgs := readProviderConfigs()
	if len(cfgs) != 1 {
		t.Fatalf("configs = %+v", cfgs)
	}
	if cfgs[0].API != "openai-completions" || cfgs[0].BaseURL != "https://old.example/v1" ||
		cfgs[0].APIKey != "old-key" || len(cfgs[0].Models) != 1 {
		t.Fatalf("config = %+v", cfgs[0])
	}
	m := cfgs[0].Models[0]
	if m.ID != "acme-1" || m.Name != "Acme One" || m.ContextWindow != 128000 || m.MaxTokens != 8192 || !m.Reasoning {
		t.Fatalf("model = %+v", m)
	}

	if err := saveProviderConfig("acme", "anthropic-messages", "https://new.example/v1", "new-key"); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	for _, want := range []string{"anthropic-messages", "https://new.example/v1", "new-key", "supportsDeveloperRole", "acme-1"} {
		if !strings.Contains(text, want) {
			t.Errorf("saved file lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "old-key") || strings.Contains(text, "https://old.example") {
		t.Errorf("old fields stayed:\n%s", text)
	}

	// Empty fields are removed, not written as "".
	if err := saveProviderConfig("acme", "", "", ""); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(path)
	text = string(raw)
	if strings.Contains(text, `"api"`) || strings.Contains(text, `"baseUrl"`) || strings.Contains(text, `"apiKey"`) {
		t.Errorf("blank fields were written:\n%s", text)
	}
}

// TestProviderKey checks the literal, $VARIABLE and provider-named forms.
func TestProviderKey(t *testing.T) {
	t.Setenv("PIDECK_TEST_KEY", "from-env")
	if got := providerKey(providerConfig{APIKey: "$PIDECK_TEST_KEY"}); got != "from-env" {
		t.Errorf("$VAR = %q", got)
	}
	if got := providerKey(providerConfig{APIKey: "${PIDECK_TEST_KEY}"}); got != "from-env" {
		t.Errorf("${VAR} = %q", got)
	}
	if got := providerKey(providerConfig{APIKey: "literal"}); got != "literal" {
		t.Errorf("literal = %q", got)
	}
	t.Setenv("ACME_API_KEY", "named-env")
	if got := providerKey(providerConfig{ID: "acme"}); got != "named-env" {
		t.Errorf("provider env = %q", got)
	}
}

// TestProviderConnection checks the three answers a probe gives.
func TestProviderConnection(t *testing.T) {
	var mode string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case mode == "ok" && r.URL.Path == "/models":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"data":[]}`))
		case mode == "unauthorized":
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"bad key"}`))
		case mode == "fallback" && r.URL.Path == "/models":
			w.WriteHeader(http.StatusNotFound)
		case mode == "fallback" && r.URL.Path == "/chat/completions":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{}`))
		default:
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer srv.Close()

	cfg := providerConfig{ID: "acme", BaseURL: srv.URL, Models: []modelConfig{{ID: "acme-1"}}}

	mode = "ok"
	if msg, err := testProviderConnection(cfg); err != nil || !strings.Contains(msg, "连接正常") {
		t.Fatalf("ok: %q, %v", msg, err)
	}
	mode = "fallback"
	if msg, err := testProviderConnection(cfg); err != nil || !strings.Contains(msg, "连接正常") {
		t.Fatalf("fallback: %q, %v", msg, err)
	}
	mode = "unauthorized"
	if _, err := testProviderConnection(cfg); err == nil || !strings.Contains(err.Error(), "认证失败") {
		t.Fatalf("unauthorized: %v", err)
	}
	if _, err := testProviderConnection(providerConfig{ID: "none"}); err == nil {
		t.Fatal("a provider without a URL should fail")
	}
}

// TestProviderDialogSaves checks the dialog writes models.json.
func TestProviderDialogSaves(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	cfgDir := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	t.Setenv("PIDECK_LITE_PI_CONFIG", cfgDir)
	body := `{"providers":{"acme":{"api":"openai-completions","baseUrl":"https://old.example/v1","models":[{"id":"acme-1"}]}}}`
	path := filepath.Join(cfgDir, "models.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-models")
	app.WaitFor("text:acme", 10*time.Second)
	app.Press("id:provider-configure-acme")
	app.WaitFor("id:provider-dialog", 5*time.Second)
	app.Clear("label:Base URL")
	app.Type("label:Base URL", "https://changed.example/v1")
	app.Press("id:provider-save")
	deadline := time.Now().Add(5 * time.Second)
	for {
		raw, err := os.ReadFile(path)
		if err == nil && strings.Contains(string(raw), "https://changed.example/v1") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("models.json after save = %s", raw)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
