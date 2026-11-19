//go:build !js && !android && !ios

package workbench

// Checks the TokenDance account pieces: the key's source, the provider
// entry it needs, the catalog merge, and the payment session shapes.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

// jsonQuote is a JSON string for a value a test writes by hand.
func jsonQuote(value string) string {
	raw, _ := json.Marshal(value)
	return string(raw)
}

// TestTokenDanceKeySource checks the key comes from pi's credential first
// and from models.json after that.
func TestTokenDanceKeySource(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PIDECK_LITE_PI_CONFIG", dir)
	t.Setenv("TD_TEST_KEY", "from-env")
	plain := "sk-" + "tokendance-1234"
	if err := os.WriteFile(filepath.Join(dir, "models.json"),
		[]byte(`{"providers":{"tokendance":{"api":"openai-completions","apiKey":"`+plain+`","models":[]}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := tokenDanceKey(); got != plain {
		t.Fatalf("models.json key = %q", got)
	}
	// An entry in auth.json wins, whether it is a literal or a variable.
	stored := "sk-" + "stored-9999"
	authBody := func(value string) []byte {
		return []byte(`{"tokendance":{"type":"api_key","key":` + jsonQuote(value) + `}}`)
	}
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), authBody(stored), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := tokenDanceKey(); got != stored {
		t.Fatalf("stored key = %q", got)
	}
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), authBody("$TD_TEST_KEY"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := tokenDanceKey(); got != "from-env" {
		t.Fatalf("variable key = %q", got)
	}
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), authBody("!op read td"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := tokenDanceKey(); got != "" {
		t.Fatalf("a command is pi's to run, got %q", got)
	}
}

// TestEnsureTokenDanceProvider adds the provider once and leaves a
// description the user has edited alone.
func TestEnsureTokenDanceProvider(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PIDECK_LITE_PI_CONFIG", dir)
	if err := ensureTokenDanceProvider(); err != nil {
		t.Fatal(err)
	}
	cfgs := readProviderConfigs()
	if len(cfgs) != 1 || cfgs[0].ID != tokenDanceProvider {
		t.Fatalf("providers = %+v", cfgs)
	}
	if cfgs[0].API != "openai-completions" || !strings.HasSuffix(cfgs[0].BaseURL, "/gateway/v1") {
		t.Fatalf("provider = %+v", cfgs[0])
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "models.json"))
	var root struct {
		Providers map[string]struct {
			Compat map[string]any `json:"compat"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(raw, &root); err != nil {
		t.Fatalf("models.json = %s", raw)
	}
	compat := root.Providers[tokenDanceProvider].Compat
	if compat["requiresReasoningContentOnAssistantMessages"] != true || compat["supportsDeveloperRole"] != false {
		t.Fatalf("compat = %+v", compat)
	}

	// A second call keeps the file as it is.
	before := string(raw)
	if err := ensureTokenDanceProvider(); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(filepath.Join(dir, "models.json"))
	if string(after) != before {
		t.Fatalf("second call rewrote models.json")
	}
}

// TestTokenDanceMerge adds the catalog's models, updates what changed, and
// keeps an entry's own fields and the models the catalog dropped.
func TestTokenDanceMerge(t *testing.T) {
	existing := []modelConfig{
		{ID: "glm-4.7", Name: "Old name", ContextWindow: 1000, MaxTokens: 4096, Reasoning: true,
			Cost: modelCost{Input: 0.5}, Compat: map[string]bool{"supportsStore": true}},
		{ID: "hand-added", Name: "Mine", ContextWindow: 32000},
	}
	catalog := []tokenDanceModel{
		{ID: "glm-4.7", Name: "Z.ai: GLM 4.7", ContextLength: 200000},
		{ID: "deepseek-v3.2", Name: "DeepSeek V3.2", ContextLength: 163840},
	}
	merged, added, updated, kept := tokenDanceMerge(existing, catalog)
	if added != 1 || updated != 2 || kept != 1 || len(merged) != 3 {
		t.Fatalf("merged=%d added=%d updated=%d kept=%d", len(merged), added, updated, kept)
	}
	first := merged[0]
	if first.Name != "Z.ai: GLM 4.7" || first.ContextWindow != 200000 {
		t.Fatalf("updated entry = %+v", first)
	}
	if first.MaxTokens != 4096 || !first.Reasoning || first.Cost.Input != 0.5 || !first.Compat["supportsStore"] {
		t.Fatalf("its own fields were lost: %+v", first)
	}
	if merged[1].ID != "hand-added" {
		t.Fatalf("an entry the catalog dropped was lost: %+v", merged)
	}
	if merged[2].ID != "deepseek-v3.2" || merged[2].ContextWindow != 163840 {
		t.Fatalf("new entry = %+v", merged[2])
	}
}

// TestChatModels keeps only the models this provider's API can call.
func TestChatModels(t *testing.T) {
	list := []tokenDanceModel{
		{ID: "a", Protocols: []string{tokenDanceOpenAI}},
		{ID: "b", Protocols: []string{"anthropic:messages"}},
		{ID: "c", Protocols: []string{"anthropic:messages", tokenDanceOpenAI}},
	}
	got := chatModels(list)
	if len(got) != 2 || got[0].ID != "a" || got[1].ID != "c" {
		t.Fatalf("chat models = %+v", got)
	}
}

// TestTokenDanceBalanceAndSession checks the platform's answers decode the
// way the page reads them.
func TestTokenDanceBalanceAndSession(t *testing.T) {
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The catalog needs no key; everything else carries it.
		if !strings.HasSuffix(r.URL.Path, "/models") && r.Header.Get("Authorization") != "Bearer sk-test" {
			t.Errorf("%s authorization = %q", r.URL.Path, r.Header.Get("Authorization"))
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/user/balance"):
			_, _ = w.Write([]byte(`{"balance":{"credits":137000000,"credits_used":132522946,"balance":4477054}}`))
		case strings.HasSuffix(r.URL.Path, "/payment/sessions") && r.Method == http.MethodPost:
			var body struct {
				Amount int `json:"amount"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.Amount != 10 {
				t.Errorf("amount = %d", body.Amount)
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"session":{"id":"s1","amount":10,"status":"pending","payment_url":"https://pay.example/s1","status_url":"` +
				srv.URL + `/sessions/s1","expired_at":4102444800}}`))
		case strings.HasSuffix(r.URL.Path, "/sessions/s1"):
			_, _ = w.Write([]byte(`{"session":{"id":"s1","amount":10,"status":"paid","paid_at":1700000000}}`))
		case strings.HasSuffix(r.URL.Path, "/models"):
			_, _ = w.Write([]byte(`{"data":[{"id":"glm-4.7","name":"GLM 4.7","context_length":200000,"supported_protocols":["openai:chat-completions"]}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	old := tokenDanceRoot
	tokenDanceRoot = srv.URL
	defer func() { tokenDanceRoot = old }()

	balance, err := fetchTokenDanceBalance("sk-test")
	if err != nil {
		t.Fatal(err)
	}
	if balance.Left != 4477054 || balance.Credits != 137000000 {
		t.Fatalf("balance = %+v", balance)
	}
	if got := yuan(balance.Left); got != "¥4.48" {
		t.Fatalf("yuan = %q", got)
	}
	session, err := createTokenDanceSession("sk-test", 10)
	if err != nil {
		t.Fatal(err)
	}
	if session.ID != "s1" || session.Status != "pending" || session.settled() {
		t.Fatalf("session = %+v", session)
	}
	paid, err := fetchTokenDanceSession("sk-test", srv.URL+"/sessions/s1")
	if err != nil {
		t.Fatal(err)
	}
	if paid.Status != "paid" || !paid.settled() || paid.PaidAt != 1700000000 {
		t.Fatalf("paid = %+v", paid)
	}
	catalog, err := fetchTokenDanceCatalog()
	if err != nil {
		t.Fatal(err)
	}
	chat := chatModels(catalog)
	if len(chat) != 1 || chat[0].ContextLength != 200000 {
		t.Fatalf("catalog = %+v", catalog)
	}
}

// TestTokenDanceError checks the platform's error body becomes the message.
func TestTokenDanceError(t *testing.T) {
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"code":"unauthorized","message":"Invalid or expired API key"}}`))
	}))
	defer srv.Close()
	old := tokenDanceRoot
	tokenDanceRoot = srv.URL
	defer func() { tokenDanceRoot = old }()
	_, err := fetchTokenDanceBalance("sk-bad")
	if err == nil || !strings.Contains(err.Error(), "Invalid or expired API key") {
		t.Fatalf("error = %v", err)
	}
}

// TestTokenDanceSettingsRows checks the account block and its dialogs open
// from the settings page.
func TestTokenDanceSettingsRows(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	cfgDir := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	t.Setenv("PIDECK_LITE_PI_CONFIG", cfgDir)
	t.Setenv("PI_CODING_AGENT_DIR", cfgDir)
	app := nsgotest.Start(t, Root, nsgotest.Size(1280, 860))
	app.Press("label:设置")
	app.WaitFor("id:settings-tab-models", 10*time.Second)
	app.Press("id:settings-tab-models")
	app.WaitFor("id:td-key-open", 20*time.Second)
	app.Press("id:td-key-open")
	app.WaitFor("id:td-key", 5*time.Second)
	app.Press("id:td-key-save")
	app.WaitFor("text:先填 API Key。", 5*time.Second)
	app.Press("label:取消")
	app.WaitForGone("id:td-key", 5*time.Second)
	app.Press("id:td-recharge-open")
	app.WaitFor("id:td-recharge", 5*time.Second)
	app.Press("id:td-pay-amount-30")
	app.Press("id:td-pay-close")
	app.WaitForGone("id:td-recharge", 5*time.Second)
}
