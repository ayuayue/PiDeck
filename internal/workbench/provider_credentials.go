//go:build !js && !android && !ios

package workbench

// Where each provider's credential comes from, and the providers pi knows
// beyond models.json: both are read off the UI thread and handed to the
// settings page as one list.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Credential kinds, as credentialInfo.Kind reports them.
const (
	credentialAuth   = "auth"   // an entry in auth.json
	credentialModels = "models" // apiKey on the provider in models.json
	credentialEnv    = "env"    // an environment variable pi reads itself
)

// credentialInfo says where a provider's key comes from.
type credentialInfo struct {
	Kind   string
	Detail string
	// Ready is false when the source exists but resolves to nothing, as an
	// unset variable does.
	Ready bool
}

// providerEnvVars are the variables pi reads a provider's key from, for
// the providers whose name differs from the provider ID.
var providerEnvVars = map[string]string{
	"anthropic":         "ANTHROPIC_API_KEY",
	"ant-ling":          "ANT_LING_API_KEY",
	"openai":            "OPENAI_API_KEY",
	"deepseek":          "DEEPSEEK_API_KEY",
	"gemini":            "GEMINI_API_KEY",
	"openrouter":        "OPENROUTER_API_KEY",
	"zai":               "ZAI_API_KEY",
	"zai-coding-cn":     "ZAI_CODING_CN_API_KEY",
	"opencode":          "OPENCODE_API_KEY",
	"opencode-go":       "OPENCODE_API_KEY",
	"radius":            "RADIUS_API_KEY",
	"kimi-coding":       "KIMI_API_KEY",
	"minimax":           "MINIMAX_API_KEY",
	"minimax-cn":        "MINIMAX_CN_API_KEY",
	"moonshot":          "MOONSHOT_API_KEY",
	"groq":              "GROQ_API_KEY",
	"mistral":           "MISTRAL_API_KEY",
	"xai":               "XAI_API_KEY",
	"cerebras":          "CEREBRAS_API_KEY",
	"fireworks":         "FIREWORKS_API_KEY",
	"together":          "TOGETHER_API_KEY",
	"baseten":           "BASETEN_API_KEY",
	"meta":              "META_API_KEY",
	"nvidia":            "NVIDIA_API_KEY",
	"typesafe":          "TYPESAFE_API_KEY",
	"huggingface":       "HF_TOKEN",
	"github-copilot":    "COPILOT_GITHUB_TOKEN",
	"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
}

// envVarOf is the variable pi reads a provider's key from, or "" when the
// provider has no documented one.
func envVarOf(provider string) string {
	if name, ok := providerEnvVars[strings.ToLower(provider)]; ok {
		return name
	}
	return ""
}

// credentialOf resolves a provider's credential the way pi does: the
// stored entry first, then the key in models.json, then the environment.
func credentialOf(id string, entry *authEntry, cfg *providerConfig) credentialInfo {
	if entry != nil {
		switch entry.Type {
		case "oauth":
			return credentialInfo{Kind: credentialAuth, Detail: "oauth", Ready: entry.Refreshable || entry.Expires == 0}
		default:
			info := credentialInfo{Kind: credentialAuth, Detail: entry.Hint, Ready: entry.Hint != ""}
			switch entry.Source {
			case keyEnv:
				info.Detail = "$" + entry.Name
				info.Ready = envSet(entry.Name)
			case keyCommand:
				info.Detail = "!" + entry.Name
				info.Ready = true
			}
			return info
		}
	}
	if cfg != nil {
		if source, name := keyOrigin(cfg.APIKey); source != "" {
			info := credentialInfo{Kind: credentialModels, Detail: cfg.APIKey, Ready: true}
			switch source {
			case keyEnv:
				info.Detail = "$" + name
				info.Ready = envSet(name)
			case keyCommand:
				info.Detail = "!" + name
			}
			if source == keyLiteral {
				info.Detail = maskKey(cfg.APIKey)
			}
			return info
		}
	}
	if name := envVarOf(id); name != "" && envSet(name) {
		return credentialInfo{Kind: credentialEnv, Detail: name, Ready: true}
	}
	return credentialInfo{}
}

// readCatalogProviders lists the providers in pi's generated model
// catalog, which pi ships as models-store.json.
func readCatalogProviders() []providerConfig {
	dir := piConfigDir()
	if dir == "" {
		return nil
	}
	raw, err := os.ReadFile(filepath.Join(dir, "models-store.json"))
	if err != nil {
		return nil
	}
	var root map[string]struct {
		Models []map[string]any `json:"models"`
	}
	if json.Unmarshal(raw, &root) != nil {
		return nil
	}
	out := make([]providerConfig, 0, len(root))
	for id, p := range root {
		cfg := providerConfig{ID: id, Builtin: true}
		for _, m := range p.Models {
			mc := modelConfig{}
			mc.ID, _ = m["id"].(string)
			mc.Name, _ = m["name"].(string)
			mc.ContextWindow = intField(m["contextWindow"])
			mc.MaxTokens = intField(m["maxTokens"])
			mc.Reasoning, _ = m["reasoning"].(bool)
			if mc.ID == "" {
				continue
			}
			if cfg.API == "" {
				cfg.API, _ = m["api"].(string)
			}
			if cfg.BaseURL == "" {
				cfg.BaseURL, _ = m["baseUrl"].(string)
			}
			cfg.Models = append(cfg.Models, mc)
		}
		if len(cfg.Models) == 0 {
			continue
		}
		out = append(out, cfg)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// mergeProviders is models.json's providers plus the ones pi knows from
// its catalog and from auth.json, with each one's credential.
func mergeProviders(cfgs []providerConfig, catalog []providerConfig, entries []authEntry) []providerInfo {
	byID := map[string]*authEntry{}
	for i := range entries {
		byID[entries[i].Provider] = &entries[i]
	}
	configs := map[string]*providerConfig{}
	for i := range cfgs {
		configs[cfgs[i].ID] = &cfgs[i]
	}
	out := make([]providerInfo, 0, len(cfgs)+len(catalog)+len(entries))
	seen := map[string]bool{}
	add := func(id, api, baseURL string, models []modelConfig, builtin bool) {
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		out = append(out, providerInfo{ID: id, API: api, BaseURL: baseURL, Models: models,
			Configured: configs[id] != nil, Builtin: builtin, Credential: credentialOf(id, byID[id], configs[id])})
	}
	for _, cfg := range cfgs {
		add(cfg.ID, cfg.API, cfg.BaseURL, cfg.Models, false)
	}
	for _, cfg := range catalog {
		add(cfg.ID, cfg.API, cfg.BaseURL, cfg.Models, true)
	}
	for _, e := range entries {
		add(e.Provider, "", "", nil, false)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// loadProviders publishes file information before asking pi to verify
// credentials, which may take longer than the file read. Only the newest
// load can replace either snapshot.
func (a *app) loadProviders(piPath string) {
	a.invalidateModelOptions(piPath)
	a.providerLoadSeq++
	seq := a.providerLoadSeq
	publish := func(list []providerInfo) {
		a.cx.Post(func() {
			if a.providerLoadSeq == seq {
				a.providers.Set(list)
			}
		})
	}
	go func() {
		entries, _ := readAuthEntries()
		list := mergeProviders(readProviderConfigs(), readCatalogProviders(), entries)
		publish(list)
		if piPath != "" && len(list) > 0 {
			publish(probeProviders(piPath, list))
		}
	}()
}
