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
	"sort"
	"strconv"
	"strings"

	"example.com/pideck-v2/internal/apptext"
)

type providerModelCredential struct {
	Value  string
	Bearer bool
}

type providerModelEndpoint struct {
	URL       string
	GoogleKey bool
}

func resolveProviderModelCredential(ctx context.Context, piPath string, cfg providerConfig) providerModelCredential {
	for _, command := range []struct {
		name   string
		bearer bool
	}{{"print-api-key", false}, {"print-bearer-token", true}} {
		if strings.TrimSpace(piPath) == "" {
			break
		}
		cmd := piCommand(ctx, piPath, "auth", command.name, "--provider", cfg.ID)
		cmd.Dir = loginDir()
		cmd.Env = append(cmd.Environ(), agentProxy.env()...)
		hideWindow(cmd)
		data, err := cmd.Output()
		if err == nil {
			if token := strings.TrimSpace(string(data)); token != "" {
				return providerModelCredential{Value: token, Bearer: command.bearer}
			}
		}
	}
	if source, _ := keyOrigin(cfg.APIKey); source == keyCommand {
		return providerModelCredential{}
	}
	return providerModelCredential{Value: providerKey(cfg)}
}

func fetchProviderModelList(ctx context.Context, client *http.Client, cfg providerConfig, credential providerModelCredential, catalog []providerConfig) ([]modelConfig, error) {
	endpoints, err := providerModelEndpoints(cfg.BaseURL, cfg.API, credential.Value)
	if err != nil {
		return nil, err
	}
	if client == nil {
		client = appHTTPClient
	}
	safeClient := *client
	safeClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	var lastErr error
	for _, endpoint := range endpoints {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.URL, nil)
		if err != nil {
			lastErr = errors.New(apptext.T("获取模型列表失败"))
			continue
		}
		request.Header.Set("Accept", "application/json")
		if strings.Contains(strings.ToLower(cfg.API), "anthropic") {
			request.Header.Set("anthropic-version", "2023-06-01")
			if credential.Value != "" {
				if credential.Bearer {
					request.Header.Set("Authorization", "Bearer "+credential.Value)
				} else {
					request.Header.Set("x-api-key", credential.Value)
				}
			}
		} else if credential.Value != "" && !endpoint.GoogleKey {
			request.Header.Set("Authorization", "Bearer "+credential.Value)
		}
		for key, value := range cfg.Headers {
			if strings.TrimSpace(key) == "" || strings.ContainsAny(key+value, "\r\n") {
				return nil, errors.New(apptext.T("请求头不能包含空名称或换行。"))
			}
			request.Header.Set(key, providerHeaderValue(value))
		}
		response, err := safeClient.Do(request)
		if err != nil {
			lastErr = errors.New(apptext.T("获取模型列表失败"))
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
		response.Body.Close()
		if readErr != nil || len(body) > 2<<20 {
			lastErr = errors.New(apptext.T("获取模型列表失败"))
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			lastErr = fmt.Errorf("%s (HTTP %d)", apptext.T("获取模型列表失败"), response.StatusCode)
			continue
		}
		models, err := parseProviderModelList(body, cfg.API)
		if err != nil || len(models) == 0 {
			lastErr = errors.New(apptext.T("获取模型列表失败"))
			continue
		}
		return mergeCatalogModels(cfg.ID, models, catalog), nil
	}
	if lastErr == nil {
		lastErr = errors.New(apptext.T("获取模型列表失败"))
	}
	return nil, lastErr
}

func providerModelEndpoints(baseURL, api, key string) ([]providerModelEndpoint, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" || parsed.User != nil {
		return nil, errors.New(apptext.T("请输入有效的 HTTP 或 HTTPS 地址。"))
	}
	api = strings.ToLower(strings.TrimSpace(api))
	if strings.Contains(api, "anthropic") {
		root := *parsed
		root.Path = strings.TrimRight(root.Path, "/")
		root.RawPath = ""
		root.Path = strings.TrimSuffix(root.Path, "/v1")
		return []providerModelEndpoint{
			{URL: appendURLPath(root, "v1/models")},
			{URL: appendURLPath(root, "models")},
		}, nil
	}
	if strings.Contains(api, "google-generative-ai") || strings.Contains(api, "gemini") {
		root := *parsed
		root.Path = strings.TrimRight(root.Path, "/")
		root.RawPath = ""
		if !strings.HasSuffix(root.Path, "/v1beta") {
			root.Path = strings.TrimSuffix(root.Path, "/v1")
			root.Path = appendPath(root.Path, "v1beta")
		}
		root.Path = appendPath(root.Path, "models")
		if key != "" {
			query := root.Query()
			query.Set("key", key)
			root.RawQuery = query.Encode()
		}
		return []providerModelEndpoint{{URL: root.String(), GoogleKey: true}}, nil
	}
	versioned := *parsed
	versioned.Path = strings.TrimRight(versioned.Path, "/")
	versioned.RawPath = ""
	if !hasVersionSuffix(versioned.Path) {
		versioned.Path = appendPath(versioned.Path, "v1")
	}
	versioned.Path = appendPath(versioned.Path, "models")
	fallback := *parsed
	fallback.Path = appendPath(strings.TrimRight(fallback.Path, "/"), "models")
	if versioned.String() == fallback.String() {
		return []providerModelEndpoint{{URL: versioned.String()}}, nil
	}
	return []providerModelEndpoint{{URL: versioned.String()}, {URL: fallback.String()}}, nil
}

func providerEndpointHost(baseURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return ""
	}
	return parsed.Scheme + "://" + parsed.Host
}

func appendURLPath(base url.URL, suffix string) string {
	base.Path = appendPath(strings.TrimRight(base.Path, "/"), suffix)
	return base.String()
}

func appendPath(base, suffix string) string {
	return strings.TrimRight(base, "/") + "/" + strings.TrimLeft(suffix, "/")
}

func hasVersionSuffix(path string) bool {
	last := strings.ToLower(path[strings.LastIndex(path, "/")+1:])
	if last == "v1" || last == "v1beta" || last == "v1alpha" {
		return true
	}
	if strings.HasPrefix(last, "v") {
		_, err := strconv.Atoi(strings.TrimPrefix(last, "v"))
		return err == nil
	}
	return false
}

func parseProviderModelList(data []byte, api string) ([]modelConfig, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var root any
	if err := decoder.Decode(&root); err != nil {
		return nil, errors.New(apptext.T("获取模型列表失败"))
	}
	items, ok := root.([]any)
	if !ok {
		object, ok := root.(map[string]any)
		if !ok {
			return nil, errors.New(apptext.T("获取模型列表失败"))
		}
		for _, key := range []string{"data", "models"} {
			if list, ok := object[key].([]any); ok {
				items = list
				break
			}
		}
	}
	models := make([]modelConfig, 0, len(items))
	seen := map[string]bool{}
	google := strings.Contains(strings.ToLower(api), "google-generative-ai") || strings.Contains(strings.ToLower(api), "gemini")
	for _, item := range items {
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id := firstString(object, "id", "name")
		if google {
			id = strings.TrimPrefix(id, "models/")
		}
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		name := firstString(object, "displayName", "name")
		if google {
			name = strings.TrimPrefix(name, "models/")
		}
		if name == "" || name == id {
			name = firstString(object, "displayName")
		}
		model := modelConfig{ID: id, Name: name}
		model.ContextWindow = firstInt(object, "contextWindow", "context_window", "contextLength", "context_length", "inputTokenLimit")
		model.MaxTokens = firstInt(object, "maxTokens", "max_tokens", "maxOutputTokens", "max_output_tokens", "outputTokenLimit")
		model.Reasoning, _ = object["reasoning"].(bool)
		if input, ok := object["input"].([]any); ok {
			for _, modality := range input {
				if strings.EqualFold(fmt.Sprint(modality), "image") {
					model.Images = true
				}
			}
		}
		models = append(models, model)
	}
	if len(models) == 0 {
		return nil, errors.New(apptext.T("获取模型列表失败"))
	}
	sortProviderModelsAlphabetically(models)
	return models, nil
}

func firstString(object map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := object[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func firstInt(object map[string]any, keys ...string) int {
	for _, key := range keys {
		if value, ok := object[key]; ok {
			if parsed := intField(value); parsed > 0 {
				return parsed
			}
		}
	}
	return 0
}

func sortProviderModelsAlphabetically(models []modelConfig) {
	sort.SliceStable(models, func(i, j int) bool {
		left, right := models[i].Name, models[j].Name
		if left == "" {
			left = models[i].ID
		}
		if right == "" {
			right = models[j].ID
		}
		if !strings.EqualFold(left, right) {
			return strings.ToLower(left) < strings.ToLower(right)
		}
		return models[i].ID < models[j].ID
	})
}

func appendSelectedProviderModels(existing, fetched []modelConfig, selected map[string]bool) ([]modelConfig, int) {
	models := append([]modelConfig(nil), existing...)
	known := make(map[string]bool, len(models))
	for _, model := range models {
		known[model.ID] = true
	}
	var added []modelConfig
	for _, model := range fetched {
		if selected[model.ID] && !known[model.ID] {
			added = append(added, model)
			known[model.ID] = true
		}
	}
	sortProviderModelsAlphabetically(added)
	return append(models, added...), len(added)
}

func mergeCatalogModels(provider string, fetched []modelConfig, catalog []providerConfig) []modelConfig {
	known := map[string]modelConfig{}
	for _, cfg := range catalog {
		if cfg.ID != provider {
			continue
		}
		for _, model := range cfg.Models {
			known[model.ID] = model
		}
		break
	}
	for i := range fetched {
		metadata, ok := known[fetched[i].ID]
		if !ok {
			continue
		}
		if fetched[i].Name == "" || fetched[i].Name == fetched[i].ID {
			fetched[i].Name = metadata.Name
		}
		if fetched[i].ContextWindow == 0 {
			fetched[i].ContextWindow = metadata.ContextWindow
		}
		if fetched[i].MaxTokens == 0 {
			fetched[i].MaxTokens = metadata.MaxTokens
		}
		if !fetched[i].Reasoning {
			fetched[i].Reasoning = metadata.Reasoning
		}
		if !fetched[i].Images {
			fetched[i].Images = metadata.Images
		}
		if fetched[i].Cost == (modelCost{}) {
			fetched[i].Cost = metadata.Cost
		}
		if fetched[i].Compat == nil {
			fetched[i].Compat = metadata.Compat
		}
	}
	sortProviderModelsAlphabetically(fetched)
	return fetched
}
