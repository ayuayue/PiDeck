//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"example.com/pideck/internal/apptext"
)

func providerHeaderValue(value string) string {
	if source, name := keyOrigin(value); source == keyEnv {
		return strings.TrimSpace(os.Getenv(name))
	} else if source == keyCommand {
		return ""
	}
	return value
}

func resolveProviderDraftCredential(ctx context.Context, piPath string, cfg providerConfig) (providerModelCredential, error) {
	if strings.TrimSpace(cfg.APIKey) == "" {
		return resolveProviderModelCredential(ctx, piPath, cfg), nil
	}
	if source, _ := keyOrigin(cfg.APIKey); source == keyCommand {
		saved, _, _, err := readProviderConnection(cfg.ID)
		if err != nil || saved.APIKey != cfg.APIKey {
			return providerModelCredential{}, errors.New(apptext.T("命令形式的密钥请先保存连接，再测试。"))
		}
		credential := resolveProviderModelCredential(ctx, piPath, cfg)
		if strings.HasPrefix(credential.Value, "!") {
			return providerModelCredential{}, errors.New(apptext.T("pi 未能解析命令密钥，请检查命令或先完成登录。"))
		}
		return credential, nil
	}
	return providerModelCredential{Value: providerKey(cfg)}, nil
}

func testProviderConnectionWith(ctx context.Context, client *http.Client, cfg providerConfig, credential providerModelCredential) (string, error) {
	endpoints, err := providerModelEndpoints(cfg.BaseURL, cfg.API, credential.Value)
	if err != nil {
		return "", err
	}
	start := time.Now()
	lastStatus := 0
	for _, endpoint := range endpoints {
		status, err := providerCheckRequest(ctx, client, http.MethodGet, endpoint.URL, nil, cfg, credential, endpoint.GoogleKey)
		if err != nil {
			return "", err
		}
		lastStatus = status
		if status >= 200 && status < 300 {
			return apptext.T("连接正常 · HTTP %d · %dms", status, time.Since(start).Milliseconds()), nil
		}
		if status == 401 || status == 403 {
			return "", fmt.Errorf("%s (HTTP %d)", apptext.T("认证失败，请检查密钥或登录状态。"), status)
		}
	}
	return "", fmt.Errorf("%s (HTTP %d)", apptext.T("模型列表不可用；可手动添加模型后测试模型请求。"), lastStatus)
}

// providerCheckRequest deliberately returns no remote body or URL: either may
// echo credentials. It also refuses redirects to keep credentials on one host.
func providerCheckRequest(ctx context.Context, client *http.Client, method, target string, body []byte, cfg providerConfig, credential providerModelCredential, google bool) (int, error) {
	if client == nil {
		client = appHTTPClient
	}
	safe := *client
	safe.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(body))
	if err != nil {
		return 0, errors.New(apptext.T("请求地址无效。"))
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if strings.Contains(cfg.API, "anthropic") {
		req.Header.Set("anthropic-version", "2023-06-01")
		if credential.Bearer {
			req.Header.Set("Authorization", "Bearer "+credential.Value)
		} else if credential.Value != "" {
			req.Header.Set("x-api-key", credential.Value)
		}
	} else if credential.Value != "" && !google {
		req.Header.Set("Authorization", "Bearer "+credential.Value)
	}
	for key, value := range cfg.Headers {
		if strings.ContainsAny(key+value, "\r\n") {
			return 0, errors.New(apptext.T("请求头不能包含空名称或换行。"))
		}
		req.Header.Set(key, providerHeaderValue(value))
	}
	response, err := safe.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return 0, errors.New(apptext.T("请求超时或已取消。"))
		}
		return 0, errors.New(apptext.T("连接失败，请检查地址、网络或代理。"))
	}
	defer response.Body.Close()
	_, err = io.Copy(io.Discard, io.LimitReader(response.Body, 512<<10))
	if err != nil {
		return 0, errors.New(apptext.T("读取供应商响应失败。"))
	}
	return response.StatusCode, nil
}

func testProviderModelWith(ctx context.Context, client *http.Client, cfg providerConfig, model string, credential providerModelCredential) (string, error) {
	root, err := url.Parse(strings.TrimRight(cfg.BaseURL, "/"))
	if err != nil || root.Hostname() == "" || (root.Scheme != "https" && root.Scheme != "http") || root.User != nil {
		return "", errors.New(apptext.T("请输入有效的 HTTP 或 HTTPS 地址。"))
	}
	var payload any
	target := ""
	google := false
	switch {
	case strings.Contains(cfg.API, "anthropic"):
		root.Path = strings.TrimSuffix(root.Path, "/v1")
		target = appendURLPath(*root, "v1/messages")
		payload = map[string]any{"model": model, "messages": []any{map[string]any{"role": "user", "content": "Hi"}}, "max_tokens": 1}
	case cfg.API == "google-generative-ai":
		root.Path = strings.TrimSuffix(strings.TrimSuffix(root.Path, "/v1beta"), "/v1")
		root.Path += "/v1beta/models/" + model + ":generateContent"
		q := root.Query()
		q.Set("key", credential.Value)
		root.RawQuery = q.Encode()
		target = root.String()
		google = true
		payload = map[string]any{"contents": []any{map[string]any{"parts": []any{map[string]any{"text": "Hi"}}}}, "generationConfig": map[string]any{"maxOutputTokens": 1}}
	case cfg.API == "openai-responses" || cfg.API == "azure-openai-responses":
		target = appendURLPath(*root, "responses")
		payload = map[string]any{"model": model, "input": "Hi", "max_output_tokens": 16, "store": false}
	case cfg.API == "openai-completions" || cfg.API == "":
		target = appendURLPath(*root, "chat/completions")
		payload = map[string]any{"model": model, "messages": []any{map[string]any{"role": "user", "content": "Hi"}}, "max_tokens": 1, "stream": false}
	default:
		return "", errors.New(apptext.T("此协议请在 pi 会话中测试；连接与用量查询仍可单独使用。"))
	}
	body, _ := json.Marshal(payload)
	start := time.Now()
	status, err := providerCheckRequest(ctx, client, http.MethodPost, target, body, cfg, credential, google)
	if err != nil {
		return "", err
	}
	if status < 200 || status >= 300 {
		return "", fmt.Errorf("%s (HTTP %d)", apptext.T("模型请求失败，请检查模型 ID、协议和兼容性参数。"), status)
	}
	return apptext.T("模型请求成功 · HTTP %d · %dms", status, time.Since(start).Milliseconds()), nil
}
