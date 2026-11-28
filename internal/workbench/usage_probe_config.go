//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"example.com/pideck/internal/apptext"
)

// usageProbeConfig mirrors the providers entries in pi's usage-probes.json.
// A missing Enabled is disabled; a missing interval is five minutes, not zero.
type usageProbeConfig struct {
	Enabled           *bool  `json:"enabled,omitempty"`
	Template          string `json:"template,omitempty"`
	APIKey            string `json:"apiKey,omitempty"`
	BaseURL           string `json:"baseUrl,omitempty"`
	AccessToken       string `json:"accessToken,omitempty"`
	UserID            string `json:"userId,omitempty"`
	Cookie            string `json:"cookie,omitempty"`
	CookiePath        string `json:"cookiePath,omitempty"`
	ValuePath         string `json:"valuePath,omitempty"`
	CurrencyPath      string `json:"currencyPath,omitempty"`
	AccessKeyID       string `json:"accessKeyId,omitempty"`
	SecretAccessKey   string `json:"secretAccessKey,omitempty"`
	PanelJWT          string `json:"panelJwt,omitempty"`
	PanelRefreshToken string `json:"panelRefreshToken,omitempty"`
	TimeoutSecs       int    `json:"timeoutSecs,omitempty"`
	IntervalMinutes   *int   `json:"intervalMinutes,omitempty"`
}

var usageProbeConfigMu sync.Mutex

var usageProbeConfigKeys = []string{
	"enabled", "template", "apiKey", "baseUrl", "accessToken", "userId", "cookie", "cookiePath",
	"valuePath", "currencyPath", "accessKeyId", "secretAccessKey", "panelJwt", "panelRefreshToken",
	"timeoutSecs", "intervalMinutes",
}

func usageProbeConfigPath() string { return filepath.Join(piConfigDir(), "usage-probes.json") }

func loadUsageProbeConfig(provider string) (usageProbeConfig, bool, error) {
	usageProbeConfigMu.Lock()
	defer usageProbeConfigMu.Unlock()
	doc, err := readUsageProbeDocument()
	if err != nil {
		return usageProbeConfig{}, false, err
	}
	providers, _ := doc["providers"].(map[string]any)
	raw, ok := providers[strings.TrimSpace(provider)]
	if !ok {
		return usageProbeConfig{}, false, nil
	}
	config, err := decodeUsageProbeConfig(raw)
	return config, true, err
}

func saveUsageProbeConfig(provider string, config usageProbeConfig) error {
	provider = strings.TrimSpace(provider)
	if provider == "" {
		return errors.New(apptext.T("用量查询供应商不能为空"))
	}
	config, err := normalizeUsageProbeConfig(config)
	if err != nil {
		return err
	}
	usageProbeConfigMu.Lock()
	defer usageProbeConfigMu.Unlock()
	doc, err := readUsageProbeDocument()
	if err != nil {
		return err
	}
	providers, _ := doc["providers"].(map[string]any)
	if providers == nil {
		providers = make(map[string]any)
		doc["providers"] = providers
	}
	entry, _ := providers[provider].(map[string]any)
	if entry == nil {
		entry = make(map[string]any)
	}
	// Replace only owned fields. Unknown root/provider keys and old probes survive.
	for _, key := range usageProbeConfigKeys {
		delete(entry, key)
	}
	encoded, _ := json.Marshal(config)
	var fields map[string]any
	if err := json.Unmarshal(encoded, &fields); err != nil {
		return errors.New(apptext.T("用量查询配置编码失败"))
	}
	for key, value := range fields {
		entry[key] = value
	}
	providers[provider] = entry
	return writeUsageProbeDocument(doc)
}

func readUsageProbeDocument() (map[string]any, error) {
	file, err := os.Open(usageProbeConfigPath())
	if errors.Is(err, os.ErrNotExist) {
		return make(map[string]any), nil
	}
	if err != nil {
		return nil, errors.New(apptext.T("无法读取用量查询配置"))
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return nil, errors.New(apptext.T("用量查询配置读取失败或超过大小限制"))
	}
	value, err := usageProbeDecodeJSON(data)
	if err != nil {
		return nil, errors.New(apptext.T("用量查询配置不是合法 JSON"))
	}
	if list, ok := value.([]any); ok {
		value = map[string]any{"probes": list}
	}
	doc, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New(apptext.T("用量查询配置必须是对象或旧探针数组"))
	}
	if raw, exists := doc["providers"]; exists {
		providers, valid := raw.(map[string]any)
		if !valid {
			return nil, errors.New(apptext.T("用量查询 providers 必须是对象"))
		}
		for _, entry := range providers {
			if _, err := decodeUsageProbeConfig(entry); err != nil {
				return nil, err
			}
		}
	}
	if raw, exists := doc["probes"]; exists {
		list, valid := raw.([]any)
		if !valid {
			return nil, errors.New(apptext.T("用量查询 probes 必须是数组"))
		}
		for _, entry := range list {
			if _, err := decodeUsageProbeLegacy(entry); err != nil {
				return nil, err
			}
		}
	}
	return doc, nil
}

func writeUsageProbeDocument(doc map[string]any) error {
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return errors.New(apptext.T("用量查询配置编码失败"))
	}
	if err := os.MkdirAll(piConfigDir(), 0o700); err != nil {
		return errors.New(apptext.T("无法创建用量查询配置目录"))
	}
	if err := writeFileAtomic(usageProbeConfigPath(), append(data, '\n'), 0o600); err != nil {
		return errors.New(apptext.T("无法保存用量查询配置"))
	}
	return nil
}

func decodeUsageProbeConfig(value any) (usageProbeConfig, error) {
	entry, ok := value.(map[string]any)
	if !ok {
		return usageProbeConfig{}, errors.New(apptext.T("用量查询 providers 条目必须是对象"))
	}
	for _, key := range usageProbeConfigKeys {
		raw, exists := entry[key]
		if !exists {
			continue
		}
		valid := false
		switch key {
		case "enabled":
			_, valid = raw.(bool)
		case "timeoutSecs", "intervalMinutes":
			number, ok := raw.(json.Number)
			if ok {
				_, err := number.Int64()
				valid = err == nil
			}
		default:
			_, valid = raw.(string)
		}
		if !valid {
			return usageProbeConfig{}, errors.New(apptext.T("用量查询配置字段类型错误"))
		}
	}
	data, err := json.Marshal(entry)
	var config usageProbeConfig
	if err != nil || json.Unmarshal(data, &config) != nil {
		return config, errors.New(apptext.T("用量查询配置字段类型错误"))
	}
	if _, exists := entry["timeoutSecs"]; exists && config.TimeoutSecs == 0 {
		return config, errors.New(apptext.T("用量查询超时须为 1–300 秒"))
	}
	return normalizeUsageProbeConfig(config)
}

func normalizeUsageProbeConfig(config usageProbeConfig) (usageProbeConfig, error) {
	for _, field := range []*string{
		&config.Template, &config.APIKey, &config.BaseURL, &config.AccessToken, &config.UserID,
		&config.Cookie, &config.CookiePath, &config.ValuePath, &config.CurrencyPath,
		&config.AccessKeyID, &config.SecretAccessKey, &config.PanelJWT, &config.PanelRefreshToken,
	} {
		*field = strings.TrimSpace(*field)
	}
	if !usageProbeTemplateKnown(config.Template) {
		return config, errors.New(apptext.T("未知用量查询模板"))
	}
	if config.BaseURL != "" && !usageProbeValidURL(config.BaseURL) {
		return config, errors.New(apptext.T("用量查询地址须为有效的 HTTP 或 HTTPS 地址"))
	}
	if config.CookiePath != "" && !usageProbeValidPath(config.CookiePath) {
		return config, errors.New(apptext.T("用量查询接口须为站点内的绝对路径"))
	}
	if config.TimeoutSecs < 0 || config.TimeoutSecs > 300 {
		return config, errors.New(apptext.T("用量查询超时须为 1–300 秒"))
	}
	if config.IntervalMinutes != nil && (*config.IntervalMinutes < 0 || *config.IntervalMinutes > 1440) {
		return config, errors.New(apptext.T("用量查询间隔须为 0–1440 分钟"))
	}
	return config, nil
}

func usageProbeValidURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != "" && u.User == nil && u.RawQuery == "" && u.Fragment == ""
}

func usageProbeValidPath(path string) bool {
	return strings.HasPrefix(path, "/") && !strings.HasPrefix(path, "//") && !strings.ContainsAny(path, "\r\n\\#")
}

// Reject duplicate keys and trailing JSON as well as malformed input; ambiguous
// JSON must never be interpreted one way and subsequently overwritten another.
func usageProbeDecodeJSON(data []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	value, err := usageProbeJSONValue(decoder, 0)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, errors.New("trailing JSON")
	}
	return value, nil
}

func usageProbeJSONValue(decoder *json.Decoder, depth int) (any, error) {
	if depth > 100 {
		return nil, errors.New("JSON nesting too deep")
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch token {
	case json.Delim('{'):
		object := make(map[string]any)
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return nil, errors.New("invalid object key")
			}
			if _, exists := object[key]; exists {
				return nil, errors.New("duplicate object key")
			}
			value, err := usageProbeJSONValue(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			object[key] = value
		}
		_, err = decoder.Token()
		return object, err
	case json.Delim('['):
		list := make([]any, 0)
		for decoder.More() {
			value, err := usageProbeJSONValue(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			list = append(list, value)
		}
		_, err = decoder.Token()
		return list, err
	case json.Delim('}'), json.Delim(']'):
		return nil, errors.New("unexpected JSON delimiter")
	default:
		return token, nil
	}
}
