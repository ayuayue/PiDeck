package main

// Providers and their credentials, for the settings page: which providers
// pi knows, how many models each offers, and whether pi can authenticate
// with them right now.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// providerInfo is one provider pi can talk to.
type providerInfo struct {
	ID      string
	API     string
	BaseURL string
	Models  int
	// Auth is "ready", "not_ready", "invalid", or "" while unknown.
	Auth     string
	AuthType string
	Reason   string
}

// modelsFile is pi's own model configuration: providers with their models.
type modelsFile struct {
	Providers map[string]struct {
		API     string `json:"api"`
		BaseURL string `json:"baseUrl"`
		Models  []struct {
			ID string `json:"id"`
		} `json:"models"`
	} `json:"providers"`
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

// readProviders lists the providers in pi's models.json.
func readProviders() []providerInfo {
	dir := piConfigDir()
	if dir == "" {
		return nil
	}
	raw, err := os.ReadFile(filepath.Join(dir, "models.json"))
	if err != nil {
		return nil
	}
	var f modelsFile
	if json.Unmarshal(raw, &f) != nil {
		return nil
	}
	out := make([]providerInfo, 0, len(f.Providers))
	for id, p := range f.Providers {
		out = append(out, providerInfo{ID: id, API: p.API, BaseURL: p.BaseURL, Models: len(p.Models)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// probeProviderAuth asks pi whether a provider's credentials resolve.
func probeProviderAuth(piPath, provider string) (status, authType, reason string) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	args := []string{"auth", "check", "--provider", provider, "--json"}
	var cmd *exec.Cmd
	if isBatch(piPath) {
		cmd = exec.CommandContext(ctx, "cmd.exe", "/d", "/s", "/c", batchLine(piPath, args))
	} else {
		cmd = exec.CommandContext(ctx, piPath, args...)
	}
	hideWindow(cmd)
	out, _ := cmd.Output()
	var res struct {
		Status   string `json:"status"`
		AuthType string `json:"authType"`
		Reason   string `json:"reason"`
	}
	if json.Unmarshal(out, &res) == nil && res.Status != "" {
		return res.Status, res.AuthType, res.Reason
	}
	return "", "", firstLine(strings.TrimSpace(string(out)), 120)
}

// probeProviders fills in the auth state of each provider, one at a time.
func probeProviders(piPath string, list []providerInfo) []providerInfo {
	out := make([]providerInfo, len(list))
	copy(out, list)
	for i := range out {
		status, kind, reason := probeProviderAuth(piPath, out[i].ID)
		out[i].Auth, out[i].AuthType, out[i].Reason = status, kind, reason
	}
	return out
}

// authLabel names an auth state for the UI.
func authLabel(p providerInfo) string {
	switch p.Auth {
	case "ready":
		return "已就绪"
	case "not_ready":
		return "未配置"
	case "invalid":
		return "已失效"
	}
	return "未知"
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
	Models  []modelConfig
}

// modelConfig is one model's line in a provider.
type modelConfig struct {
	ID            string
	Name          string
	ContextWindow int
	MaxTokens     int
	Reasoning     bool
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
	if root == nil {
		root = map[string]any{}
	}
	providers, _ := root["providers"].(map[string]any)
	if providers == nil {
		providers = map[string]any{}
		root["providers"] = providers
	}
	p, _ := providers[id].(map[string]any)
	if p == nil {
		p = map[string]any{"models": []any{}}
		providers[id] = p
	}
	setOrDelete(p, "api", strings.TrimSpace(api))
	setOrDelete(p, "baseUrl", strings.TrimSpace(baseURL))
	setOrDelete(p, "apiKey", strings.TrimSpace(apiKey))
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

// writeFileAtomic replaces a file in one step, so a crash cannot leave
// half a config behind.
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	tmp := path + ".pideck.tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// providerKey resolves the key a request to a provider uses: the field
// itself, a $VARIABLE it names, or a variable named after the provider.
func providerKey(cfg providerConfig) string {
	key := strings.TrimSpace(cfg.APIKey)
	if key != "" {
		if ref, ok := strings.CutPrefix(key, "${"); ok {
			return strings.TrimSpace(os.Getenv(strings.TrimSuffix(ref, "}")))
		}
		if ref, ok := strings.CutPrefix(key, "$"); ok {
			return strings.TrimSpace(os.Getenv(ref))
		}
		return key
	}
	id := strings.ToUpper(strings.NewReplacer("-", "_", ".", "_").Replace(cfg.ID))
	for _, name := range []string{id + "_API_KEY", id + "_KEY", "OPENAI_API_KEY"} {
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
