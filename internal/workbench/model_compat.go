//go:build !js && !android && !ios

package workbench

// The parts of a models.json entry the provider dialog shows beyond its
// three fields: image input, price, and the compatibility switches an
// OpenAI-compatible endpoint sometimes needs set by hand. Only the fields
// naming these are written back; the rest of the entry stays as it was.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// compatFlags are the switches the compatibility editor shows. They are
// pi's own field names, so they read the same as the file.
var compatFlags = []string{
	"supportsStore",
	"supportsDeveloperRole",
	"supportsReasoningEffort",
	"supportsUsageInStreaming",
	"requiresToolResultName",
	"requiresThinkingAsText",
	"requiresReasoningContentOnAssistantMessages",
}

// compatOpenAI says whether a provider's API reads the compatibility
// switches. Other APIs have their own, which the editor leaves alone.
func compatOpenAI(api string) bool {
	return api == "" || strings.HasPrefix(api, "openai-")
}

// inputHasImage reads pi's input list.
func inputHasImage(v any) bool {
	list, _ := v.([]any)
	for _, item := range list {
		if s, _ := item.(string); s == "image" {
			return true
		}
	}
	return false
}

// readModelCost reads a model's price per million tokens.
func readModelCost(v any) modelCost {
	cost, _ := v.(map[string]any)
	return modelCost{
		Input:      numberField(cost["input"]),
		Output:     numberField(cost["output"]),
		CacheRead:  numberField(cost["cacheRead"]),
		CacheWrite: numberField(cost["cacheWrite"]),
	}
}

// readCompat keeps the flags the editor shows, leaving out the others.
func readCompat(v any, flags []string) map[string]bool {
	fields, _ := v.(map[string]any)
	if len(fields) == 0 {
		return nil
	}
	out := map[string]bool{}
	for _, flag := range flags {
		if value, ok := fields[flag].(bool); ok {
			out[flag] = value
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// priceSet says a model names a price at all.
func (c modelCost) priceSet() bool {
	return c.Input > 0 || c.Output > 0 || c.CacheRead > 0 || c.CacheWrite > 0
}

// applyModelEntry writes the fields the editor shows into a models.json
// entry, keeping every field it does not show.
func applyModelEntry(entry map[string]any, m modelConfig) {
	entry["id"] = m.ID
	setOrDelete(entry, "name", m.Name)
	if m.ContextWindow > 0 {
		entry["contextWindow"] = m.ContextWindow
	} else {
		delete(entry, "contextWindow")
	}
	if m.MaxTokens > 0 {
		entry["maxTokens"] = m.MaxTokens
	} else {
		delete(entry, "maxTokens")
	}
	if m.Reasoning {
		entry["reasoning"] = true
	} else {
		delete(entry, "reasoning")
	}
	if m.Images {
		entry["input"] = []any{"text", "image"}
	} else {
		delete(entry, "input")
	}
	if m.Cost.priceSet() {
		entry["cost"] = map[string]any{
			"input":      m.Cost.Input,
			"output":     m.Cost.Output,
			"cacheRead":  m.Cost.CacheRead,
			"cacheWrite": m.Cost.CacheWrite,
		}
	} else {
		delete(entry, "cost")
	}
	compat, _ := entry["compat"].(map[string]any)
	if compat == nil {
		compat = map[string]any{}
	}
	for _, flag := range compatFlags {
		if value, ok := m.Compat[flag]; ok {
			compat[flag] = value
		} else {
			delete(compat, flag)
		}
	}
	if len(compat) > 0 {
		entry["compat"] = compat
	} else {
		delete(entry, "compat")
	}
}

// catalogPath is pi's generated model catalog, cached beside its settings.
func catalogPath() string {
	dir := piConfigDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "models-store.json")
}

// catalogCompat is the compatibility pi's catalog already states for a
// built-in model, or nil when the catalog does not know it. It is the
// suggestion the dialog shows, not something it writes.
func catalogCompat(provider, model string) map[string]bool {
	path := catalogPath()
	if path == "" || provider == "" || model == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var root map[string]struct {
		Models []struct {
			ID     string         `json:"id"`
			Compat map[string]any `json:"compat"`
		} `json:"models"`
	}
	if json.Unmarshal(raw, &root) != nil {
		return nil
	}
	for _, m := range root[provider].Models {
		if m.ID != model {
			continue
		}
		return readCompat(m.Compat, compatFlags)
	}
	return nil
}

// compatSuggestion words the catalog's advice for the flags the entry
// leaves unset.
func compatSuggestion(suggest map[string]bool, current map[string]bool) string {
	if len(suggest) == 0 {
		return ""
	}
	var parts []string
	for _, flag := range compatFlags {
		want, ok := suggest[flag]
		if !ok {
			continue
		}
		if have, set := current[flag]; set && have == want {
			continue
		}
		parts = append(parts, flag+"="+boolText(want))
	}
	sort.Strings(parts)
	return strings.Join(parts, " ")
}

// boolText writes a flag's value as models.json would.
func boolText(v bool) string {
	if v {
		return "true"
	}
	return "false"
}
