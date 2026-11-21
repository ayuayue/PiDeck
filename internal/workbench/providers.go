//go:build !js && !android && !ios

package workbench

// Providers and their credentials, for the settings page: which providers
// pi knows, how many models each offers, and whether pi can authenticate
// with them right now.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"example.com/pideck-lite/internal/apptext"
)

// providerInfo is one provider pi can talk to.
type providerInfo struct {
	ID      string
	API     string
	BaseURL string
	Models  []modelConfig
	// Configured means the provider has an entry in models.json.
	Configured bool
	// Builtin says pi's own catalog knows the provider, so models.json
	// does not have to describe it.
	Builtin bool
	// Auth is "ready", "not_ready", "invalid", or "" while unknown.
	Auth     string
	AuthType string
	Reason   string
	// Credential is where the key comes from, as the settings page says.
	Credential credentialInfo
}

// piConfigDir is pi's own configuration folder. PIDECK_LITE_PI_CONFIG
// points it elsewhere, for a test or a portable install.
func piConfigDir() string {
	if dir := strings.TrimSpace(os.Getenv("PIDECK_LITE_PI_CONFIG")); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".pi", "agent")
}

// probeProviders fills in the auth state of each provider, one process
// each. Four run at a time so a long catalog does not take a minute.
func probeProviders(piPath string, list []providerInfo) []providerInfo {
	out := make([]providerInfo, len(list))
	copy(out, list)
	if strings.TrimSpace(piPath) == "" {
		return out
	}
	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for i := range out {
		i := i
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			out[i].Auth, out[i].AuthType, out[i].Reason = probeOneProvider(piPath, out[i].ID)
		}()
	}
	wg.Wait()
	return out
}

// probeOneProvider asks pi about one provider. A failure to answer at all
// is reported as the row's reason, not as a missing credential.
func probeOneProvider(piPath, provider string) (status, authType, reason string) {
	res, err := checkAuth(piPath, provider, true)
	if err != nil {
		return "", "", err.Error()
	}
	return res.Status, res.AuthType, res.Reason
}

// authLabel names an auth state for the UI.
func authLabel(p providerInfo) string {
	switch p.Auth {
	case "ready":
		return apptext.T("已就绪")
	case "not_ready":
		return apptext.T("未配置")
	case "invalid":
		return apptext.T("已失效")
	}
	return apptext.T("未知")
}

// authReason turns pi's reason code into a line to read.
func authReason(code string) string {
	switch code {
	case "":
		return ""
	case "provider_not_found":
		return apptext.T("pi 不认识这个供应商")
	case "credentials_not_configured":
		return apptext.T("没有可用的凭据")
	case "credential_not_available":
		return apptext.T("凭据解析不出来")
	case "invalid_state":
		return apptext.T("凭据已失效")
	}
	return code
}

// credentialLabel names a credential's source for the UI.
func credentialLabel(info credentialInfo) string {
	switch info.Kind {
	case credentialAuth:
		return apptext.T("auth.json")
	case credentialModels:
		return apptext.T("models.json")
	case credentialEnv:
		return apptext.T("环境变量")
	}
	return apptext.T("没有凭据")
}

// loginCommand is what the user runs in a terminal to sign in.
func loginCommand(p providerInfo) string {
	return fmt.Sprintf("pi auth login %s", p.ID)
}

// providerConfig is one provider's editable settings, read from
// models.json. Unknown fields are left where they are when it is saved.
type providerConfig struct {
	ID      string
	API     string
	BaseURL string
	APIKey  string
	// Models are the provider's entries; the catalog's when Builtin.
	Models []modelConfig
	// Builtin says the entry came from pi's catalog, not models.json.
	Builtin bool
}

// modelConfig is one model's line in a provider.
type modelConfig struct {
	ID            string
	Name          string
	ContextWindow int
	MaxTokens     int
	Reasoning     bool
	// Images says the model takes image input; pi's input lists "text"
	// and, when this is set, "image".
	Images bool
	Cost   modelCost
	// Compat holds the compatibility flags the editor shows. A flag the
	// file does not name is absent, which pi reads as auto-detect.
	Compat map[string]bool
}

// modelCost is a model's price per million tokens, in USD.
type modelCost struct {
	Input      float64
	Output     float64
	CacheRead  float64
	CacheWrite float64
}

// modelsJSONPath is pi's model file.
func modelsJSONPath() string {
	dir := piConfigDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "models.json")
}

// readProviderConfigs reads the providers with their editable fields.
func readProviderConfigs() []providerConfig {
	path := modelsJSONPath()
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var root map[string]any
	if json.Unmarshal(raw, &root) != nil {
		return nil
	}
	providers, _ := root["providers"].(map[string]any)
	out := make([]providerConfig, 0, len(providers))
	for id, v := range providers {
		p, _ := v.(map[string]any)
		if p == nil {
			continue
		}
		cfg := providerConfig{ID: id}
		cfg.API, _ = p["api"].(string)
		cfg.BaseURL, _ = p["baseUrl"].(string)
		cfg.APIKey, _ = p["apiKey"].(string)
		if list, ok := p["models"].([]any); ok {
			for _, rawModel := range list {
				m, _ := rawModel.(map[string]any)
				if m == nil {
					continue
				}
				mc := modelConfig{}
				mc.ID, _ = m["id"].(string)
				mc.Name, _ = m["name"].(string)
				mc.ContextWindow = intField(m["contextWindow"])
				mc.MaxTokens = intField(m["maxTokens"])
				mc.Reasoning, _ = m["reasoning"].(bool)
				mc.Images = inputHasImage(m["input"])
				mc.Cost = readModelCost(m["cost"])
				mc.Compat = readCompat(m["compat"], compatFlags)
				cfg.Models = append(cfg.Models, mc)
			}
		}
		out = append(out, cfg)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// intField reads a JSON number as an int.
func intField(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case json.Number:
		i, _ := n.Int64()
		return int(i)
	}
	return 0
}

// saveProviderConfig writes a provider's fields back to models.json,
// keeping every other field and provider as it was.
func saveProviderConfig(id, api, baseURL, apiKey string) error {
	return writeProviderConfig(providerConfig{ID: id, API: api, BaseURL: baseURL, APIKey: apiKey}, false)
}

var errProviderExists = errors.New("provider already exists")

// writeProviderConfig creates a new provider with its first model or edits
// an existing provider's connection fields. Unknown JSON fields stay intact.
func writeProviderConfig(cfg providerConfig, create bool) error {
	id := strings.TrimSpace(cfg.ID)
	if id == "" {
		return fmt.Errorf("供应商 ID 不能为空")
	}
	path := modelsJSONPath()
	if path == "" {
		return fmt.Errorf("找不到 pi 的配置目录")
	}
	raw, err := os.ReadFile(path)
	if err != nil && !(create && errors.Is(err, os.ErrNotExist)) {
		return err
	}
	var root map[string]any
	if err == nil {
		if err := json.Unmarshal(raw, &root); err != nil {
			return fmt.Errorf("models.json 不是有效的 JSON：%w", err)
		}
		if create && root == nil {
			return errors.New("models.json: expected a JSON object")
		}
	} else if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if root == nil {
		root = map[string]any{}
	}
	providers, _ := root["providers"].(map[string]any)
	if providers == nil {
		if create && root["providers"] != nil {
			return fmt.Errorf("models.json: providers must be an object")
		}
		providers = map[string]any{}
		root["providers"] = providers
	}
	p, _ := providers[id].(map[string]any)
	if _, exists := providers[id]; exists && create {
		return errProviderExists
	}
	if p == nil {
		p = map[string]any{"models": []any{}}
		providers[id] = p
	}
	setOrDelete(p, "api", strings.TrimSpace(cfg.API))
	setOrDelete(p, "baseUrl", strings.TrimSpace(cfg.BaseURL))
	setOrDelete(p, "apiKey", strings.TrimSpace(cfg.APIKey))
	if create {
		models := make([]any, 0, len(cfg.Models))
		for _, model := range cfg.Models {
			entry := map[string]any{"id": model.ID}
			applyModelEntry(entry, model)
			models = append(models, entry)
		}
		p["models"] = models
	}
	data, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(path, append(data, '\n'), 0o600)
}

// setOrDelete sets a string field, or removes it when blank.
func setOrDelete(m map[string]any, key, value string) {
	if value == "" {
		delete(m, key)
		return
	}
	m[key] = value
}

// providerKey resolves the key a request to a provider uses: the field
// itself, a $VARIABLE it names, or a variable named after the provider.
func providerKey(cfg providerConfig) string {
	key := strings.TrimSpace(cfg.APIKey)
	if key != "" {
		if source, name := keyOrigin(key); source == keyEnv {
			return strings.TrimSpace(os.Getenv(name))
		}
		return key
	}
	id := strings.ToUpper(strings.NewReplacer("-", "_", ".", "_").Replace(cfg.ID))
	for _, name := range []string{envVarOf(cfg.ID), id + "_API_KEY", id + "_KEY", "OPENAI_API_KEY"} {
		if name == "" {
			continue
		}
		if v := strings.TrimSpace(os.Getenv(name)); v != "" {
			return v
		}
	}
	return ""
}

// testProviderConnection asks a provider whether it answers: its model
// list first, then one-token chat when the list is not served.
func testProviderConnection(cfg providerConfig) (string, error) {
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if base == "" {
		return "", fmt.Errorf("没有 Base URL")
	}
	key := providerKey(cfg)
	start := time.Now()
	status, body, err := providerRequest("GET", base+"/models", key, nil)
	elapsed := time.Since(start).Milliseconds()
	if err == nil && status >= 200 && status < 300 {
		return fmt.Sprintf("连接正常 · HTTP %d · %dms", status, elapsed), nil
	}
	if len(cfg.Models) > 0 {
		payload := fmt.Sprintf(`{"model":%q,"messages":[{"role":"user","content":"ping"}],"max_tokens":1}`,
			cfg.Models[0].ID)
		start = time.Now()
		st, text, err2 := providerRequest("POST", base+"/chat/completions", key, []byte(payload))
		elapsed = time.Since(start).Milliseconds()
		if err2 == nil {
			switch {
			case st >= 200 && st < 300:
				return fmt.Sprintf("连接正常 · HTTP %d · %dms", st, elapsed), nil
			case st == 400 || st == 422:
				return fmt.Sprintf("服务可达 · HTTP %d（请求被拒绝，检查模型名或参数）", st), nil
			case st == 401 || st == 403:
				return "", fmt.Errorf("认证失败 · HTTP %d：%s", st, shorten(string(text), 160))
			default:
				return "", fmt.Errorf("HTTP %d：%s", st, shorten(string(text), 160))
			}
		}
	}
	if err != nil {
		return "", err
	}
	if status == 401 || status == 403 {
		return "", fmt.Errorf("认证失败 · HTTP %d：%s", status, shorten(string(body), 160))
	}
	return "", fmt.Errorf("HTTP %d：%s", status, shorten(string(body), 160))
}

// providerRequest sends one small request to a provider.
func providerRequest(method, url, key string, body []byte) (int, []byte, error) {
	return providerRequestTimeout(method, url, key, body, 12*time.Second)
}

// providerRequestTimeout is providerRequest with its own deadline, for
// calls such as image generation that take longer than a probe.
func providerRequestTimeout(method, url, key string, body []byte, timeout time.Duration) (int, []byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return 0, nil, err
	}
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("x-api-key", key)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := appHTTPClient
	if timeout > appHTTPClient.Timeout {
		client = appHTTPLongClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	// Image responses carry base64 pictures, and a long answer can pass
	// the old 4 KB cap; read generously and let the caller trim errors.
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	return resp.StatusCode, data, nil
}

// balanceEndpoint names the URL that reports a provider's remaining
// credit, for the providers that have one.
func balanceEndpoint(cfg providerConfig) (string, string, error) {
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if base == "" {
		return "", "", fmt.Errorf("没有 Base URL")
	}
	name := strings.ToLower(cfg.ID + " " + base)
	switch {
	case strings.Contains(name, "openrouter"):
		return base + "/credits", "openrouter", nil
	case strings.Contains(name, "moonshot") || strings.Contains(name, "kimi"):
		return base + "/users/me/balance", "moonshot", nil
	case strings.Contains(name, "deepseek"):
		return strings.TrimSuffix(base, "/v1") + "/user/balance", "deepseek", nil
	case strings.Contains(name, "siliconflow"):
		return base + "/user/info", "siliconflow", nil
	}
	return "", "", fmt.Errorf("这个供应商没有已知的余额接口")
}

// balanceSpec is a provider's own balance endpoint: a URL (absolute, or
// a path under its Base URL), the JSON path to the amount, and the
// currency.
type balanceSpec struct {
	URL      string `json:"url,omitempty"`
	Path     string `json:"path,omitempty"`
	Currency string `json:"currency,omitempty"`
}

// providerBalanceWith uses a custom endpoint when one is configured, and
// the known providers otherwise.
func providerBalanceWith(cfg providerConfig, spec *balanceSpec) (string, error) {
	if spec != nil && (strings.TrimSpace(spec.URL) != "" || strings.TrimSpace(spec.Path) != "") {
		return customBalance(cfg, *spec)
	}
	return providerBalance(cfg)
}

// customBalance reads an amount from a provider's own endpoint.
func customBalance(cfg providerConfig, spec balanceSpec) (string, error) {
	rawURL := strings.TrimSpace(spec.URL)
	path := strings.TrimSpace(spec.Path)
	if path == "" {
		path = "balance"
	}
	if rawURL == "" {
		return "", fmt.Errorf("先填余额接口")
	}
	if !isHTTPURL(rawURL) {
		base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
		if base == "" {
			return "", fmt.Errorf("这个供应商没有 Base URL")
		}
		rawURL = base + "/" + strings.TrimLeft(rawURL, "/")
	}
	status, body, err := providerRequest(http.MethodGet, rawURL, providerKey(cfg), nil)
	if err != nil {
		return "", err
	}
	if status < 200 || status >= 300 {
		return "", fmt.Errorf("HTTP %d：%s", status, shorten(string(body), 160))
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var root any
	if dec.Decode(&root) != nil {
		return "", fmt.Errorf("返回的不是 JSON")
	}
	value, ok := jsonPath(root, path)
	if !ok {
		return "", fmt.Errorf("返回里没有 %s", path)
	}
	amount, ok := floatField(value)
	if !ok {
		return "", fmt.Errorf("%s 不是数字", path)
	}
	if currency := strings.TrimSpace(spec.Currency); currency != "" {
		return fmt.Sprintf("余额 %s%.2f", currencySymbol(currency), amount), nil
	}
	return fmt.Sprintf("余额 %.2f", amount), nil
}

// jsonPath walks a dotted path through maps and array indexes.
func jsonPath(root any, path string) (any, bool) {
	cur := root
	for _, part := range strings.Split(path, ".") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		switch node := cur.(type) {
		case map[string]any:
			next, ok := node[part]
			if !ok {
				return nil, false
			}
			cur = next
		case []any:
			idx, err := strconv.Atoi(part)
			if err != nil || idx < 0 || idx >= len(node) {
				return nil, false
			}
			cur = node[idx]
		default:
			return nil, false
		}
	}
	return cur, true
}

// providerBalance asks a provider how much credit is left.
func providerBalance(cfg providerConfig) (string, error) {
	url, kind, err := balanceEndpoint(cfg)
	if err != nil {
		return "", err
	}
	status, body, err := providerRequest("GET", url, providerKey(cfg), nil)
	if err != nil {
		return "", err
	}
	if status < 200 || status >= 300 {
		return "", fmt.Errorf("HTTP %d：%s", status, shorten(string(body), 160))
	}
	var root map[string]any
	if json.Unmarshal(body, &root) != nil {
		return "", fmt.Errorf("返回的不是 JSON")
	}
	data, _ := root["data"].(map[string]any)
	switch kind {
	case "openrouter":
		credits, ok := floatField(data["total_credits"])
		if !ok {
			return "", fmt.Errorf("返回里没有 total_credits")
		}
		used, _ := floatField(data["total_usage"])
		return fmt.Sprintf("余额 $%.2f · 已用 $%.2f / 总额 $%.2f", credits-used, used, credits), nil
	case "moonshot":
		bal, ok := floatField(data["available_balance"])
		if !ok {
			return "", fmt.Errorf("返回里没有 available_balance")
		}
		return fmt.Sprintf("余额 ¥%.2f", bal), nil
	case "deepseek":
		infos, _ := root["balance_infos"].([]any)
		if len(infos) == 0 {
			return "", fmt.Errorf("返回里没有 balance_infos")
		}
		info, _ := infos[0].(map[string]any)
		bal, ok := floatField(info["total_balance"])
		if !ok {
			return "", fmt.Errorf("返回里没有 total_balance")
		}
		return fmt.Sprintf("余额 %s%.2f", currencySymbol(strField(info["currency"])), bal), nil
	case "siliconflow":
		bal, ok := floatField(data["balance"])
		if !ok {
			return "", fmt.Errorf("返回里没有 balance")
		}
		return fmt.Sprintf("余额 ¥%.2f", bal), nil
	}
	return "", fmt.Errorf("这个供应商没有已知的余额接口")
}

// currencySymbol is a currency code's mark, or the code itself.
func currencySymbol(code string) string {
	switch strings.ToUpper(code) {
	case "CNY", "RMB":
		return "¥"
	case "USD":
		return "$"
	}
	return code + " "
}

// floatField reads a JSON number that may be a string.
func floatField(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(n), 64)
		return f, err == nil
	}
	return 0, false
}

// strField reads a JSON string.
func strField(v any) string {
	s, _ := v.(string)
	return s
}

// saveProviderModels writes a provider's model entries, keeping the
// fields of each entry the editor does not show.
func saveProviderModels(id string, models []modelConfig) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return fmt.Errorf("供应商 ID 不能为空")
	}
	path := modelsJSONPath()
	if path == "" {
		return fmt.Errorf("找不到 pi 的配置目录")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil {
		return fmt.Errorf("models.json 不是有效的 JSON：%w", err)
	}
	providers, _ := root["providers"].(map[string]any)
	p, _ := providers[id].(map[string]any)
	if p == nil {
		return fmt.Errorf("models.json 里没有这个供应商")
	}
	existing := map[string]map[string]any{}
	if list, ok := p["models"].([]any); ok {
		for _, v := range list {
			m, _ := v.(map[string]any)
			if m == nil {
				continue
			}
			if mid, _ := m["id"].(string); mid != "" {
				existing[mid] = m
			}
		}
	}
	out := make([]any, 0, len(models))
	for _, m := range models {
		m.ID = strings.TrimSpace(m.ID)
		m.Name = strings.TrimSpace(m.Name)
		if m.ID == "" {
			continue
		}
		entry := existing[m.ID]
		if entry == nil {
			entry = map[string]any{"id": m.ID}
		}
		applyModelEntry(entry, m)
		out = append(out, entry)
	}
	p["models"] = out
	data, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(path, append(data, '\n'), 0o600)
}

// providerConfigured says models.json describes the provider itself, as
// opposed to pi's catalog knowing it.
func providerConfigured(id string) bool {
	for _, cfg := range readProviderConfigs() {
		if cfg.ID == id {
			return true
		}
	}
	return false
}
