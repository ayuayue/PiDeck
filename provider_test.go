package main

// Checks for reading and writing pi's provider settings, resolving a
// key, and the connection test's answers.

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/core"
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

// TestProviderBalance checks the four known balance endpoints and the
// provider without one.
func TestProviderBalance(t *testing.T) {
	var body, path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		if r.Header.Get("Authorization") != "Bearer test-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()
	cases := []struct{ id, path, payload, want string }{
		{"openrouter", "/credits", `{"data":{"total_credits":100,"total_usage":12.5}}`, "余额 $87.50"},
		{"moonshot", "/users/me/balance", `{"data":{"available_balance":12.34}}`, "余额 ¥12.34"},
		{"deepseek", "/user/balance", `{"balance_infos":[{"currency":"CNY","total_balance":"9.90"}]}`, "余额 ¥9.90"},
		{"siliconflow", "/user/info", `{"data":{"balance":"5.00"}}`, "余额 ¥5.00"},
	}
	for _, c := range cases {
		body = c.payload
		path = ""
		cfg := providerConfig{ID: c.id, BaseURL: srv.URL, APIKey: "test-key"}
		got, err := providerBalance(cfg)
		if err != nil || !strings.Contains(got, c.want) {
			t.Errorf("%s: %q, %v", c.id, got, err)
		}
		if path != c.path {
			t.Errorf("%s asked %q", c.id, path)
		}
	}
	body = `{}`
	if _, err := providerBalance(providerConfig{ID: "acme", BaseURL: srv.URL, APIKey: "test-key"}); err == nil {
		t.Error("a provider without an endpoint should fail")
	}
}

// TestCustomBalance reads a provider's own endpoint with a JSON path.
func TestCustomBalance(t *testing.T) {
	var path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		if r.Header.Get("Authorization") != "Bearer k" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"data":{"credit":"12.5","list":[{"left":3}]}}`))
	}))
	defer srv.Close()
	cfg := providerConfig{ID: "acme", BaseURL: srv.URL + "/v1", APIKey: "k"}
	got, err := providerBalanceWith(cfg, &balanceSpec{URL: "/billing", Path: "data.credit", Currency: "USD"})
	if err != nil || got != "余额 $12.50" {
		t.Fatalf("relative = %q, %v", got, err)
	}
	if path != "/v1/billing" {
		t.Fatalf("asked %q", path)
	}
	got, err = providerBalanceWith(cfg, &balanceSpec{URL: srv.URL + "/billing", Path: "data.list.0.left"})
	if err != nil || got != "余额 3.00" {
		t.Fatalf("absolute/indexed = %q, %v", got, err)
	}
	if _, err := providerBalanceWith(cfg, &balanceSpec{URL: "/billing", Path: "data.missing"}); err == nil ||
		!strings.Contains(err.Error(), "data.missing") {
		t.Fatalf("missing path error = %v", err)
	}
	if _, err := providerBalanceWith(cfg, &balanceSpec{URL: "/billing", Path: "data.credit", Currency: "JPY"}); err != nil {
		t.Fatal(err)
	}
}

// TestProviderDialogBalance checks the dialog's balance button, against a
// local server standing in for SiliconFlow.
func TestProviderDialogBalance(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/user/info" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`{"data":{"balance":"5.00"}}`))
	}))
	defer srv.Close()
	home := t.TempDir()
	cfgDir := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	t.Setenv("PIDECK_LITE_PI_CONFIG", cfgDir)
	body := fmt.Sprintf(`{"providers":{"siliconflow":{"api":"openai-completions","baseUrl":%q,"apiKey":"test-key","models":[{"id":"m1"}]}}}`, srv.URL)
	if err := os.WriteFile(filepath.Join(cfgDir, "models.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-models")
	app.WaitFor("text:siliconflow", 10*time.Second)
	app.Press("id:provider-configure-siliconflow")
	app.WaitFor("id:provider-dialog", 5*time.Second)
	app.Press("id:provider-balance")
	waitApp(app, "text:余额 ¥5.00", 10*time.Second)
}

// TestProviderCustomBalanceDialog sets a provider's own endpoint in the
// dialog, queries it, and keeps the fields in config.json.
func TestProviderCustomBalanceDialog(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/billing" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`{"data":{"credit":"7.25"}}`))
	}))
	defer srv.Close()
	home := t.TempDir()
	cfgDir := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	t.Setenv("PIDECK_LITE_PI_CONFIG", cfgDir)
	body := fmt.Sprintf(`{"providers":{"acme":{"api":"openai-completions","baseUrl":%q,"apiKey":"k","models":[{"id":"m1"}]}}}`, srv.URL+"/v1")
	if err := os.WriteFile(filepath.Join(cfgDir, "models.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-models")
	app.WaitFor("text:acme", 10*time.Second)
	app.Press("id:provider-configure-acme")
	app.WaitFor("id:provider-dialog", 5*time.Second)
	app.Type("id:provider-balance-url", "/billing")
	app.Type("id:provider-balance-path", "data.credit")
	app.Type("id:provider-balance-currency", "USD")
	app.Press("id:provider-balance")
	waitApp(app, "text:余额 $7.25", 10*time.Second)
	app.Press("id:provider-save")
	deadline := time.Now().Add(5 * time.Second)
	for {
		raw, err := os.ReadFile(filepath.Join(home, "config.json"))
		if err == nil && strings.Contains(string(raw), `"balances"`) && strings.Contains(string(raw), "data.credit") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("config.json after save = %s", raw)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// TestSaveProviderModels keeps the fields the editor does not show.
func TestSaveProviderModels(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PIDECK_LITE_PI_CONFIG", dir)
	path := filepath.Join(dir, "models.json")
	body := `{"providers":{"acme":{"api":"openai-completions","baseUrl":"https://x/v1",
		"models":[{"id":"m1","name":"One","contextWindow":128000,"compat":{"note":"keep"}},
		          {"id":"m2","name":"Two"}]}}}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	list := []modelConfig{
		{ID: "m1", Name: "One changed", ContextWindow: 64000, MaxTokens: 4096, Reasoning: true},
		{ID: "m3", Name: "Three"},
	}
	if err := saveProviderModels("acme", list); err != nil {
		t.Fatal(err)
	}
	cfgs := readProviderConfigs()
	if len(cfgs) != 1 || len(cfgs[0].Models) != 2 {
		t.Fatalf("configs = %+v", cfgs)
	}
	m := cfgs[0].Models[0]
	if m.ID != "m1" || m.Name != "One changed" || m.ContextWindow != 64000 || m.MaxTokens != 4096 || !m.Reasoning {
		t.Fatalf("m1 = %+v", m)
	}
	if cfgs[0].Models[1].ID != "m3" {
		t.Fatalf("m3 missing: %+v", cfgs[0].Models)
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), `"compat"`) || !strings.Contains(string(raw), "keep") {
		t.Fatalf("compat fields were dropped:\n%s", raw)
	}
	if strings.Contains(string(raw), `"m2"`) {
		t.Fatalf("a removed model stayed:\n%s", raw)
	}
}

// TestProviderModelEditor adds, edits and removes a model from the dialog.
func TestProviderModelEditor(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	cfgDir := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	t.Setenv("PIDECK_LITE_PI_CONFIG", cfgDir)
	path := filepath.Join(cfgDir, "models.json")
	body := `{"providers":{"acme":{"api":"openai-completions","baseUrl":"https://x/v1","models":[{"id":"m1","name":"One"}]}}}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("label:设置")
	app.Press("id:settings-tab-models")
	app.WaitFor("text:acme", 10*time.Second)
	app.Press("id:provider-configure-acme")
	app.WaitFor("id:provider-dialog", 5*time.Second)
	app.ScrollTo("id:provider-scroll", core.Point{Y: 400})
	app.Press("id:provider-model-id")
	app.Type("id:provider-model-id", "new-1")
	app.Type("id:provider-model-name", "New Model")
	app.Type("id:provider-model-context", "32000")
	app.Press("id:provider-model-save")
	raw, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(raw), "new-1") || !strings.Contains(string(raw), "32000") {
		t.Fatalf("models.json = %s, %v", raw, err)
	}
	app.ScrollTo("id:provider-scroll", core.Point{Y: 400})
	app.WaitFor("id:provider-model-new-1", 5*time.Second)
	app.Press("id:provider-model-new-1")
	app.WaitUntil(5*time.Second, func() bool { return app.Find("id:provider-model-id").Text == "new-1" })
	app.Clear("id:provider-model-name")
	app.Type("id:provider-model-name", "Renamed")
	app.Press("id:provider-model-save")
	deadline := time.Now().Add(5 * time.Second)
	for {
		raw, err = os.ReadFile(path)
		if err == nil && strings.Contains(string(raw), "Renamed") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("models.json after rename = %s, %v", raw, err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	app.Press("id:provider-model-remove-new-1")
	app.ScrollTo("id:provider-scroll", core.Point{Y: 400})
	app.WaitForGone("id:provider-model-new-1", 5*time.Second)
	raw, err = os.ReadFile(path)
	if err != nil || strings.Contains(string(raw), "new-1") {
		t.Fatalf("models.json after removing = %s, %v", raw, err)
	}
}
