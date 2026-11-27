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
	"regexp"
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
)

const usageProbeMaxResponse = 64 << 10

var usageProbeAPIKeyPlaceholder = regexp.MustCompile(`(?i)\{\{\s*apiKey\s*\}\}`)

func queryProviderUsage(ctx context.Context, client *http.Client, provider providerConfig, credential providerModelCredential, config usageProbeConfig) (usageProbeResult, error) {
	config, err := normalizeUsageProbeConfig(config)
	if err != nil {
		return usageProbeResult{}, err
	}
	enabled, _, timeout, _ := effectiveUsageProbe(provider, config)
	if !enabled {
		return usageProbeResult{}, errors.New(apptext.T("用量查询未启用"))
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()
	candidates, base, key, err := buildUsageProbeCandidates(provider, credential, config)
	if err != nil {
		return usageProbeResult{}, err
	}
	if len(candidates) == 0 {
		return usageProbeResult{}, errors.New(apptext.T("未找到适用的用量查询模板"))
	}
	if client == nil {
		client = appHTTPClient
	}
	if client == nil {
		client = http.DefaultClient
	}
	// A shallow copy shares the caller's transport, but does not mutate their
	// redirect policy. Refuse redirects even on the same origin, matching dev.
	safeClient := *client
	safeClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	lastErr := errors.New(apptext.T("用量接口响应格式不匹配"))
	for _, candidate := range candidates {
		if ctx.Err() != nil {
			return usageProbeResult{}, usageProbeContextError(ctx)
		}
		if key == "" && !candidate.noBearer && !usageProbeHasAuthorization(candidate.headers) {
			lastErr = errors.New(apptext.T("用量查询缺少凭据"))
			continue
		}
		urls, err := usageProbeURLs(candidate, base)
		if err != nil {
			lastErr = err
			continue
		}
		headers := usageProbeHeaders(candidate, key)
		if candidate.preflight {
			body, _, err := usageProbeRequest(ctx, &safeClient, http.MethodGet, "https://cli-chat-proxy.grok.com/v1/user?include=subscription", headers, nil)
			if err != nil {
				lastErr = err
				continue
			}
			userID := usageProbeString(usageProbeGet(body, "userId"))
			if userID == "" || len(userID) > 512 || strings.ContainsAny(userID, "\r\n") {
				lastErr = errors.New(apptext.T("用量接口预检未返回有效用户标识"))
				continue
			}
			headers.Set("x-userid", userID)
		}
		for _, endpoint := range urls {
			body, _, err := usageProbeRequest(ctx, &safeClient, candidate.method, endpoint, headers, candidate.body)
			if err != nil {
				lastErr = err
				continue
			}
			values, matched := usageProbeParseBody(body, candidate.parse)
			if !matched {
				lastErr = errors.New(apptext.T("用量接口响应格式不匹配"))
				continue
			}
			panelWarning := ""
			if config.Template == "sub2api" && config.PanelJWT != "" && values.balance == nil {
				balance, warning := usageProbePanelBalance(ctx, &safeClient, provider.ID, base, config)
				if balance != nil {
					values.balance, values.currency = balance, "USD"
				}
				panelWarning = warning
			}
			result := usageProbeFormat(values)
			if panelWarning != "" {
				result.Details = append(result.Details, panelWarning)
			}
			if result.Summary == "" {
				lastErr = errors.New(apptext.T("用量接口未返回可显示的数据"))
				continue
			}
			return result, nil
		}
	}
	if ctx.Err() != nil {
		return usageProbeResult{}, usageProbeContextError(ctx)
	}
	return usageProbeResult{}, lastErr
}

func usageProbeHasAuthorization(headers map[string]string) bool {
	for key := range headers {
		if strings.EqualFold(key, "Authorization") {
			return true
		}
	}
	return false
}

func usageProbeHeaders(candidate usageProbeCandidate, key string) http.Header {
	headers := make(http.Header)
	headers.Set("Accept", "application/json")
	if key != "" && !candidate.noBearer && !usageProbeHasAuthorization(candidate.headers) {
		headers.Set("Authorization", "Bearer "+key)
	}
	for name, value := range candidate.headers {
		// ReplaceAllString would interpret '$' in credentials as regexp groups.
		headers.Set(name, usageProbeAPIKeyPlaceholder.ReplaceAllStringFunc(value, func(string) string { return key }))
	}
	return headers
}

func usageProbeContextError(ctx context.Context) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return errors.New(apptext.T("用量查询超时"))
	}
	return errors.New(apptext.T("用量查询已取消"))
}

// Only status codes and fixed messages escape this boundary. URLs, response
// bodies, header values and transport errors may contain secrets and stay here.
func usageProbeRequest(ctx context.Context, client *http.Client, method, endpoint string, headers http.Header, body any) (any, int, error) {
	if ctx.Err() != nil {
		return nil, 0, usageProbeContextError(ctx)
	}
	u, err := url.Parse(endpoint)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
		return nil, 0, errors.New(apptext.T("用量查询地址无效"))
	}
	if method == "" {
		method = http.MethodGet
	}
	if method != http.MethodGet && method != http.MethodPost {
		return nil, 0, errors.New(apptext.T("用量查询请求方法无效"))
	}
	var payload []byte
	if body != nil {
		payload, err = json.Marshal(body)
		if err != nil {
			return nil, 0, errors.New(apptext.T("用量查询请求编码失败"))
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, 0, errors.New(apptext.T("用量查询请求无效"))
	}
	req.Header = headers.Clone()
	if body != nil && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, 0, usageProbeContextError(ctx)
		}
		return nil, 0, errors.New(apptext.T("无法连接用量查询接口"))
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, response.StatusCode, fmt.Errorf(apptext.T("用量接口返回 HTTP %d"), response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, usageProbeMaxResponse+1))
	if err != nil {
		return nil, response.StatusCode, errors.New(apptext.T("读取用量查询响应失败"))
	}
	if len(data) > usageProbeMaxResponse {
		return nil, response.StatusCode, errors.New(apptext.T("用量查询响应超过 64 KiB 限制"))
	}
	parsed, err := usageProbeDecodeJSON(data)
	if err != nil {
		return nil, response.StatusCode, errors.New(apptext.T("用量接口未返回合法 JSON"))
	}
	return parsed, response.StatusCode, nil
}
