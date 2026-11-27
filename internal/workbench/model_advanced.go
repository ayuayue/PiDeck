//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"strings"

	"example.com/pideck-v2/internal/apptext"
)

type modelAdvancedConfig struct {
	UserAgent        string
	ThinkingLevelMap map[string]any
	Tiers            []map[string]any
}

func readModelAdvanced(provider, id string) (modelAdvancedConfig, error) {
	var out modelAdvancedConfig
	if strings.TrimSpace(provider) == "" || strings.TrimSpace(id) == "" {
		return out, invalidAdvancedModel()
	}
	p, err := readModelsProvider(provider)
	if err != nil {
		return out, err
	}
	if out.UserAgent, err = readModelUserAgent(p, id); err != nil {
		return out, err
	}
	model, err := findAdvancedModel(p, id)
	if err != nil {
		return out, err
	}
	if value, exists := model["thinkingLevelMap"]; exists && value != nil {
		levels, ok := value.(map[string]any)
		if !ok || !validThinkingLevelMap(levels) {
			return out, invalidAdvancedModel()
		}
		out.ThinkingLevelMap = cloneAdvancedMap(levels)
	}
	out.Tiers, err = readModelCostTiers(model)
	return out, err
}

func writeModelAdvanced(provider, id string, config modelAdvancedConfig) error {
	if strings.TrimSpace(provider) == "" || strings.TrimSpace(id) == "" || strings.ContainsAny(config.UserAgent, "\r\n") {
		return invalidAdvancedModel()
	}
	if config.ThinkingLevelMap != nil && !validThinkingLevelMap(config.ThinkingLevelMap) {
		return invalidAdvancedModel()
	}
	if config.Tiers != nil {
		if err := validateModelCostTiers(config.Tiers); err != nil {
			return err
		}
	}
	return mutateModelsDocument(false, func(providers map[string]any) error {
		p, err := providerDocument(providers, provider)
		if err != nil {
			return err
		}
		model, err := findAdvancedModel(p, id)
		if err != nil {
			return err
		}
		if cost, exists := model["cost"]; exists {
			if _, ok := cost.(map[string]any); !ok {
				return invalidAdvancedModel()
			}
		}
		if err := setModelUserAgentOverride(p, id, config.UserAgent); err != nil {
			return err
		}
		if config.ThinkingLevelMap == nil {
			delete(model, "thinkingLevelMap")
		} else {
			model["thinkingLevelMap"] = cloneAdvancedMap(config.ThinkingLevelMap)
		}
		cost, _ := model["cost"].(map[string]any)
		if cost == nil && config.Tiers != nil {
			cost = map[string]any{}
			model["cost"] = cost
		}
		if cost != nil {
			if config.Tiers == nil {
				delete(cost, "tiers")
			} else {
				tiers := make([]any, len(config.Tiers))
				for i, tier := range config.Tiers {
					tiers[i] = cloneAdvancedMap(tier)
				}
				cost["tiers"] = tiers
			}
		}
		return nil
	})
}

func resetProviderModel(provider, id string) error {
	defaults, ok := catalogModelConfig(provider, id)
	if !ok {
		return errors.New(apptext.T("模型已被修改或删除，请重新打开。"))
	}
	return mutateModelsDocument(false, func(providers map[string]any) error {
		p, err := providerDocument(providers, provider)
		if err != nil {
			return err
		}
		model, err := findAdvancedModel(p, id)
		if err != nil {
			return err
		}
		applyModelEntry(model, defaults)
		if cost, ok := model["cost"].(map[string]any); ok {
			delete(cost, "tiers")
		}
		delete(model, "thinkingLevelMap")
		return setModelUserAgentOverride(p, id, "")
	})
}

func readModelsProvider(provider string) (map[string]any, error) {
	modelsFileMu.Lock()
	defer modelsFileMu.Unlock()
	path := modelsJSONPath()
	if path == "" {
		return nil, errors.New(apptext.T("找不到 pi 的配置目录"))
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New(apptext.T("models.json 不是有效的 JSON 对象。"))
	}
	value, decodeErr := usageProbeDecodeJSON(raw)
	root, ok := value.(map[string]any)
	if decodeErr != nil || !ok || root == nil {
		return nil, errors.New(apptext.T("models.json 不是有效的 JSON 对象。"))
	}
	providers, ok := root["providers"].(map[string]any)
	if !ok {
		return nil, errors.New(apptext.T("models.json 的 providers 必须是对象。"))
	}
	return providerDocument(providers, provider)
}

func readModelUserAgent(provider map[string]any, id string) (string, error) {
	headers, err := objectPath(provider, "modelOverrides", id, "headers")
	if err != nil || headers == nil {
		return "", err
	}
	userAgent, exists := headers["User-Agent"]
	if !exists {
		return "", nil
	}
	value, ok := userAgent.(string)
	if !ok {
		return "", invalidAdvancedModel()
	}
	return value, nil
}

func objectPath(root map[string]any, keys ...string) (map[string]any, error) {
	for _, key := range keys {
		value, exists := root[key]
		if !exists {
			return nil, nil
		}
		var ok bool
		root, ok = value.(map[string]any)
		if !ok {
			return nil, invalidAdvancedModel()
		}
	}
	return root, nil
}

func readModelCostTiers(model map[string]any) ([]map[string]any, error) {
	costValue, exists := model["cost"]
	if !exists {
		return nil, nil
	}
	cost, ok := costValue.(map[string]any)
	if !ok {
		return nil, invalidAdvancedModel()
	}
	raw, exists := cost["tiers"]
	if !exists || raw == nil {
		return nil, nil
	}
	list, ok := raw.([]any)
	if !ok {
		return nil, invalidAdvancedModel()
	}
	tiers := make([]map[string]any, 0, len(list))
	for _, value := range list {
		tier, ok := value.(map[string]any)
		if !ok {
			return nil, invalidAdvancedModel()
		}
		tiers = append(tiers, cloneAdvancedMap(tier))
	}
	return tiers, nil
}

func setModelUserAgentOverride(provider map[string]any, id, userAgent string) error {
	create := userAgent != ""
	overrides, err := objectChild(provider, "modelOverrides", create)
	if err != nil || overrides == nil {
		return err
	}
	entry, err := objectChild(overrides, id, create)
	if err != nil || entry == nil {
		return err
	}
	headers, err := objectChild(entry, "headers", create)
	if err != nil || headers == nil {
		return err
	}
	if create {
		headers["User-Agent"] = userAgent
	} else {
		delete(headers, "User-Agent")
	}
	return nil
}

func objectChild(parent map[string]any, key string, create bool) (map[string]any, error) {
	value, exists := parent[key]
	if !exists {
		if !create {
			return nil, nil
		}
		value = map[string]any{}
		parent[key] = value
	}
	child, ok := value.(map[string]any)
	if !ok {
		return nil, invalidAdvancedModel()
	}
	return child, nil
}

func catalogModelConfig(provider, id string) (modelConfig, bool) {
	for _, catalog := range readCatalogProviders() {
		if catalog.ID == provider {
			for _, model := range catalog.Models {
				if model.ID == id {
					return model, true
				}
			}
		}
	}
	return modelConfig{}, false
}

func findAdvancedModel(provider map[string]any, id string) (map[string]any, error) {
	list, _ := provider["models"].([]any)
	for _, value := range list {
		model, ok := value.(map[string]any)
		if ok && strField(model["id"]) == id {
			return model, nil
		}
	}
	return nil, errors.New(apptext.T("模型已被修改或删除，请重新打开。"))
}

func validThinkingLevelMap(levels map[string]any) bool {
	for _, value := range levels {
		switch value.(type) {
		case string, nil:
		default:
			return false
		}
	}
	return true
}

func validateModelCostTiers(tiers []map[string]any) error {
	last := -1.0
	for _, tier := range tiers {
		threshold, ok := finiteNonnegativeNumber(tier["inputTokensAbove"])
		if !ok || threshold <= last {
			return invalidAdvancedModel()
		}
		last = threshold
		for _, key := range []string{"input", "output", "cacheRead", "cacheWrite"} {
			if _, ok := finiteNonnegativeNumber(tier[key]); !ok {
				return errors.New(apptext.T("价格必须是有效的非负数字。"))
			}
		}
	}
	return nil
}

func finiteNonnegativeNumber(value any) (float64, bool) {
	switch value.(type) {
	case float64, json.Number:
	default:
		return 0, false
	}
	number, ok := floatField(value)
	return number, ok && number >= 0 && !math.IsNaN(number) && !math.IsInf(number, 0)
}

func cloneAdvancedMap(source map[string]any) map[string]any {
	copy := make(map[string]any, len(source))
	for key, value := range source {
		copy[key] = value
	}
	return copy
}
func invalidAdvancedModel() error {
	return errors.New(apptext.T("模型条目无效，请先检查 models.json。"))
}
