//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"example.com/pideck/internal/apptext"
)

// All models.json writers merge their own fields into the latest document.
var modelsFileMu sync.Mutex

func mutateModelsDocument(create bool, change func(map[string]any) error) error {
	modelsFileMu.Lock()
	defer modelsFileMu.Unlock()
	path := modelsJSONPath()
	if path == "" {
		return errors.New(apptext.T("找不到 pi 的配置目录"))
	}
	before, err := os.ReadFile(path)
	missing := errors.Is(err, os.ErrNotExist)
	if err != nil && !(create && missing) {
		return err
	}
	root := map[string]any{}
	if !missing {
		if len(before) > 8<<20 {
			return errors.New(apptext.T("models.json 过大，请先检查文件。"))
		}
		value, decodeErr := usageProbeDecodeJSON(before)
		var ok bool
		root, ok = value.(map[string]any)
		if decodeErr != nil || !ok || root == nil {
			return errors.New(apptext.T("models.json 不是有效的 JSON 对象。"))
		}
	}
	providers, ok := root["providers"].(map[string]any)
	if !ok {
		if _, exists := root["providers"]; exists {
			return errors.New(apptext.T("models.json 的 providers 必须是对象。"))
		}
		providers = map[string]any{}
		root["providers"] = providers
	}
	if err := change(providers); err != nil {
		return err
	}
	data, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return err
	}
	current, readErr := os.ReadFile(path)
	if (missing && !errors.Is(readErr, os.ErrNotExist)) || (!missing && (readErr != nil || !bytes.Equal(current, before))) {
		return errors.New(apptext.T("配置已被其他程序修改，请重新打开后再保存。"))
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	return writeFileAtomic(path, append(data, '\n'), 0600)
}

func providerDocument(providers map[string]any, id string) (map[string]any, error) {
	p, ok := providers[id].(map[string]any)
	if !ok || p == nil {
		return nil, errors.New(apptext.T("models.json 中没有有效的供应商配置。"))
	}
	if models, exists := p["models"]; exists {
		if _, ok := models.([]any); !ok {
			return nil, errors.New(apptext.T("供应商的 models 必须是数组。"))
		}
	}
	return p, nil
}

func validProviderID(id string) bool {
	if strings.TrimSpace(id) != id || id == "" {
		return false
	}
	for _, r := range id {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.') {
			return false
		}
	}
	return true
}

func updateProviderConnection(cfg providerConfig, headers map[string]string, compat map[string]bool) error {
	return mutateModelsDocument(false, func(providers map[string]any) error {
		p, err := providerDocument(providers, cfg.ID)
		if err != nil {
			return err
		}
		applyProviderConnection(p, cfg)
		if headers != nil {
			if len(headers) == 0 {
				delete(p, "headers")
			} else {
				p["headers"] = headers
			}
		}
		if compat != nil {
			existing, _ := p["compat"].(map[string]any)
			if existing == nil {
				existing = map[string]any{}
			}
			for _, flag := range compatFlags {
				if value, ok := compat[flag]; ok {
					existing[flag] = value
				} else {
					delete(existing, flag)
				}
			}
			if len(existing) == 0 {
				delete(p, "compat")
			} else {
				p["compat"] = existing
			}
		}
		return nil
	})
}

func applyProviderConnection(p map[string]any, cfg providerConfig) {
	setOrDelete(p, "api", strings.TrimSpace(cfg.API))
	setOrDelete(p, "baseUrl", strings.TrimSpace(cfg.BaseURL))
	setOrDelete(p, "apiKey", strings.TrimSpace(cfg.APIKey))
}

func readProviderConnection(id string) (providerConfig, map[string]string, map[string]bool, error) {
	raw, err := os.ReadFile(modelsJSONPath())
	if err != nil {
		return providerConfig{}, nil, nil, err
	}
	var root map[string]any
	if err = json.Unmarshal(raw, &root); err != nil || root == nil {
		return providerConfig{}, nil, nil, errors.New(apptext.T("models.json 不是有效的 JSON 对象。"))
	}
	providers, _ := root["providers"].(map[string]any)
	p, err := providerDocument(providers, id)
	if err != nil {
		return providerConfig{}, nil, nil, err
	}
	cfg := providerConfig{ID: id, API: strField(p["api"]), BaseURL: strField(p["baseUrl"]), APIKey: strField(p["apiKey"])}
	for _, item := range readProviderConfigs() {
		if item.ID == id {
			cfg.Models = item.Models
			break
		}
	}
	headers := map[string]string{}
	if values, exists := p["headers"]; exists {
		object, ok := values.(map[string]any)
		if !ok {
			return cfg, nil, nil, errors.New(apptext.T("请求头必须是名称与文本值组成的对象。"))
		}
		for k, v := range object {
			value, ok := v.(string)
			if !ok {
				return cfg, nil, nil, errors.New(apptext.T("请求头必须是名称与文本值组成的对象。"))
			}
			headers[k] = value
		}
	}
	cfg.Headers = headers
	return cfg, headers, readCompat(p["compat"], compatFlags), nil
}

func cloneProviderConfig(from, to string) error {
	if !validProviderID(to) {
		return errors.New(apptext.T("供应商 ID 只能包含英文字母、数字、点、短横线和下划线。"))
	}
	return mutateModelsDocument(false, func(providers map[string]any) error {
		if _, exists := providers[to]; exists {
			return errProviderExists
		}
		p, err := providerDocument(providers, from)
		if err != nil {
			return err
		}
		providers[to] = p
		return nil
	})
}

func deleteProviderConfig(id string) error {
	return mutateModelsDocument(false, func(providers map[string]any) error {
		if _, err := providerDocument(providers, id); err != nil {
			return err
		}
		delete(providers, id)
		return nil
	})
}

// writeProviderModel is a single-entry mutation; a refreshed list cannot
// overwrite another model added while the editor was open.
func writeProviderModel(provider, editing string, m modelConfig) error {
	if strings.TrimSpace(m.ID) == "" {
		return errors.New(apptext.T("还差模型 ID"))
	}
	return mutateModelsDocument(false, func(providers map[string]any) error {
		p, err := providerDocument(providers, provider)
		if err != nil {
			return err
		}
		list, _ := p["models"].([]any)
		index := -1
		for i, v := range list {
			entry, _ := v.(map[string]any)
			id := strField(entry["id"])
			if id == m.ID && id != editing {
				return errors.New(apptext.T("模型 ID 已存在，请编辑现有模型。"))
			}
			if id == editing && editing != "" {
				index = i
			}
		}
		if editing != "" && index < 0 {
			return errors.New(apptext.T("模型已被修改或删除，请重新打开。"))
		}
		entry := map[string]any{}
		if index >= 0 {
			entry, _ = list[index].(map[string]any)
		}
		applyModelEntry(entry, m)
		if index >= 0 {
			list[index] = entry
		} else {
			list = append(list, entry)
		}
		p["models"] = list
		if editing != "" && editing != m.ID {
			if overrides, ok := p["modelOverrides"].(map[string]any); ok {
				if value, exists := overrides[editing]; exists {
					if _, conflict := overrides[m.ID]; conflict {
						return errors.New(apptext.T("新模型 ID 已有独立覆盖配置，请先处理冲突。"))
					}
					overrides[m.ID] = value
					delete(overrides, editing)
				}
			}
		}
		return nil
	})
}

func deleteProviderModel(provider, id string) error {
	return deleteProviderModels(provider, []string{id})
}

func deleteProviderModels(provider string, ids []string) error {
	selected := map[string]bool{}
	for _, id := range ids {
		selected[id] = true
	}
	return mutateModelsDocument(false, func(providers map[string]any) error {
		p, err := providerDocument(providers, provider)
		if err != nil {
			return err
		}
		list, _ := p["models"].([]any)
		out := make([]any, 0, len(list))
		found := map[string]bool{}
		for _, v := range list {
			entry, _ := v.(map[string]any)
			id := strField(entry["id"])
			if selected[id] {
				found[id] = true
				continue
			}
			out = append(out, v)
		}
		if len(found) != len(selected) {
			return errors.New(apptext.T("模型已被修改或删除，请重新打开。"))
		}
		p["models"] = out
		if overrides, ok := p["modelOverrides"].(map[string]any); ok {
			for id := range selected {
				delete(overrides, id)
			}
			if len(overrides) == 0 {
				delete(p, "modelOverrides")
			}
		}
		return nil
	})
}

func validateModelNumbers(context, max, in, out, read, write string) error {
	for _, value := range []string{context, max} {
		if strings.TrimSpace(value) != "" {
			n, err := strconv.Atoi(strings.TrimSpace(value))
			if err != nil || n < 0 {
				return errors.New(apptext.T("上下文与最大输出必须是非负整数；留空使用默认值。"))
			}
		}
	}
	if context != "" && max != "" && modelCount(max) > modelCount(context) {
		return errors.New(apptext.T("最大输出不能超过上下文窗口。"))
	}
	for _, value := range []string{in, out, read, write} {
		if strings.TrimSpace(value) != "" {
			n, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
			if err != nil || n < 0 || math.IsInf(n, 0) || math.IsNaN(n) {
				return errors.New(apptext.T("价格必须是有效的非负数字。"))
			}
		}
	}
	return nil
}

func providerHeadersText(headers map[string]string) string {
	if len(headers) == 0 {
		return ""
	}
	data, _ := json.MarshalIndent(headers, "", "  ")
	return string(data)
}

func parseProviderHeaders(value string) (map[string]string, error) {
	headers := map[string]string{}
	if strings.TrimSpace(value) == "" {
		return headers, nil
	}
	if err := json.Unmarshal([]byte(value), &headers); err != nil || headers == nil {
		return nil, errors.New(apptext.T("请求头必须是名称与文本值组成的 JSON 对象。"))
	}
	for key, value := range headers {
		if strings.TrimSpace(key) == "" || strings.ContainsAny(key+value, "\r\n") {
			return nil, fmt.Errorf("%s", apptext.T("请求头不能包含空名称或换行。"))
		}
	}
	return headers, nil
}
