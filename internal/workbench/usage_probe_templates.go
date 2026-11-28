//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"regexp"
	"strings"

	"example.com/pideck/internal/apptext"
)

func usageProbeBuiltinCandidates() []usageProbeCandidate {
	custom := func(path, template string, root bool, hosts ...string) usageProbeCandidate {
		return usageProbeCandidate{path: path, template: template, rootPath: root, hosts: hosts, parse: usageProbeParse{kind: "custom", resolver: template}}
	}
	balance := func(path, template, value, currency string, hosts ...string) usageProbeCandidate {
		return usageProbeCandidate{path: path, template: template, hosts: hosts, parse: usageProbeParse{kind: "balance", valuePath: value, currencyPath: currency}}
	}
	zhipu := usageProbeCandidate{
		path: "/api/monitor/usage/quota/limit", rootPath: true, template: "zhipu-quota", hosts: []string{"open.bigmodel.cn", "api.z.ai"},
		headers: map[string]string{"Authorization": "{{apiKey}}"},
		parse:   usageProbeParse{kind: "credits", totalPath: "data.limits[0].usage", usedPath: "data.limits[0].currentValue"},
	}
	for _, window := range []struct{ key, unit string }{{"fiveHour", "3"}, {"weekly", "6"}, {"mcpMonthly", ""}} {
		w := usageProbeWindowSpec{key: window.key, listPath: "data.limits", totalPath: "usage", usedPath: "currentValue", percentPath: "percentage"}
		if window.unit == "" {
			w.where = []usageProbeCondition{{"type", "TIME_LIMIT"}}
		} else {
			w.where = []usageProbeCondition{{"type", []any{"CREDIT_LIMIT", "TOKENS_LIMIT"}}, {"unit", json.Number(window.unit)}}
		}
		zhipu.parse.windows = append(zhipu.parse.windows, w)
	}
	codex := custom("/wham/usage", "codex-usage", false, "chatgpt.com")
	codex.apiTypes = []string{"openai-codex-responses"}
	xai := custom("/v1/billing?format=credits", "xai-billing", false, "api.x.ai")
	xai.absoluteURL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits"
	xai.preflight = true
	xai.headers = map[string]string{"X-XAI-Token-Auth": "xai-grok-cli", "x-grok-client-version": "1.0.10", "x-grok-client-mode": "interactive"}
	fallback := balance("/usage", "", "balance", "unit")
	fallback.apiTypes = []string{"openai-completions", "openai-responses", "openai-codex-responses"}
	return []usageProbeCandidate{
		{path: "/usage", template: "opencode-usage", hosts: []string{"opencode.ai/zen", "opencode.ai/inference"}, parse: usageProbeParse{kind: "periods"}},
		balance("/user/balance", "deepseek-balance", "balance_infos[0].total_balance", "balance_infos[0].currency", "api.deepseek.com"),
		{path: "/key", template: "openrouter-credits", hosts: []string{"openrouter.ai"}, parse: usageProbeParse{kind: "credits", totalPath: "data.limit", usedPath: "data.usage", remainingPath: "data.limit_remaining"}},
		custom("/usages", "kimi-credits", false, "api.kimi.com"),
		balance("/users/me/balance", "moonshot-balance", "data.available_balance", "", "api.moonshot.ai", "api.moonshot.cn"),
		zhipu, codex, xai,
		custom("/alpha/billing/credits", "commandcode-credits", true, "api.commandcode.ai"),
		{path: "/portal/api/v1/user/balance", template: "tokendance-balance", rootPath: true, hosts: []string{"tokendance.space"}, parse: usageProbeParse{kind: "credits", totalPath: "balance.credits", usedPath: "balance.credits_used", remainingPath: "balance.balance", scale: 1_000_000}},
		custom("/v1/token_plan/remains", "minimax-plan", true, "minimaxi.com", "minimax.io"),
		custom("/v1/api/openplatform/coding_plan/remains", "minimax-plan", true, "minimaxi.com", "minimax.io"),
		fallback,
	}
}

func recognizedUsageTemplate(provider providerConfig) string {
	for _, candidate := range usageProbeBuiltinCandidates() {
		if candidate.template != "" && usageProbeApplies(candidate, provider) {
			return candidate.template
		}
	}
	return ""
}

func effectiveUsageProbe(provider providerConfig, config usageProbeConfig) (enabled bool, template string, timeoutSecs int, intervalMinutes int) {
	enabled = config.Enabled != nil && *config.Enabled
	template = strings.TrimSpace(config.Template)
	if template == "" {
		template = recognizedUsageTemplate(provider)
	}
	timeoutSecs = config.TimeoutSecs
	if timeoutSecs < 1 || timeoutSecs > 300 {
		timeoutSecs = 10
	}
	intervalMinutes = 5
	if config.IntervalMinutes != nil && *config.IntervalMinutes >= 0 && *config.IntervalMinutes <= 1440 {
		intervalMinutes = *config.IntervalMinutes
	}
	return
}

func usageProbeTemplateKnown(template string) bool {
	switch template {
	case "", "general", "newapi", "cookie", "volcengine", "sub2api":
		return true
	}
	for _, candidate := range usageProbeBuiltinCandidates() {
		if candidate.template == template {
			return true
		}
	}
	return false
}

func usageProbeApplies(candidate usageProbeCandidate, provider providerConfig) bool {
	if len(candidate.hosts) > 0 {
		matched := false
		for _, host := range candidate.hosts {
			if strings.Contains(strings.ToLower(provider.BaseURL), strings.ToLower(host)) {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	if len(candidate.apiTypes) > 0 {
		for _, api := range candidate.apiTypes {
			if provider.API == api {
				return true
			}
		}
		return false
	}
	return true
}

func buildUsageProbeCandidates(provider providerConfig, credential providerModelCredential, config usageProbeConfig) ([]usageProbeCandidate, string, string, error) {
	base, key := provider.BaseURL, credential.Value
	if config.BaseURL != "" {
		base = config.BaseURL
	}
	if config.APIKey != "" {
		source, name := keyOrigin(config.APIKey)
		switch source {
		case keyCommand:
			return nil, base, "", errors.New(apptext.T("用量查询不支持执行命令形式的密钥，请使用环境变量或令牌"))
		case keyEnv:
			key = strings.TrimSpace(os.Getenv(name))
			if key == "" {
				return nil, base, "", errors.New(apptext.T("用量查询密钥引用的环境变量为空或未设置"))
			}
		default:
			key = config.APIKey
		}
	}
	general := usageProbeCandidate{path: "/usage", parse: usageProbeParse{kind: "balance", valuePath: "balance", currencyPath: "unit"}}
	switch config.Template {
	case "general":
		if config.ValuePath != "" {
			general.parse.valuePath, general.parse.currencyPath = config.ValuePath, config.CurrencyPath
			if config.BaseURL != "" {
				general.absoluteURL = config.BaseURL
			}
		}
		return []usageProbeCandidate{general}, base, key, nil
	case "newapi":
		if config.AccessToken == "" || config.UserID == "" {
			return nil, base, key, errors.New(apptext.T("New API 模板需要访问令牌和用户 ID"))
		}
		return []usageProbeCandidate{{path: "/api/user/self", noVersion: true,
			headers: map[string]string{"Authorization": "Bearer " + config.AccessToken, "New-Api-User": config.UserID},
			parse:   usageProbeParse{kind: "credits", remainingPath: "data.quota", usedPath: "data.used_quota", scale: 500000}}}, usageProbeStripVersion(base), key, nil
	case "cookie":
		if config.Cookie == "" || config.CookiePath == "" || config.ValuePath == "" {
			return nil, base, key, errors.New(apptext.T("Cookie 模板需要 Cookie、接口路径和余额字段路径"))
		}
		return []usageProbeCandidate{{path: config.CookiePath, noVersion: true, noBearer: true,
			headers: map[string]string{"Cookie": config.Cookie}, parse: usageProbeParse{kind: "balance", valuePath: config.ValuePath, currencyPath: config.CurrencyPath}}}, usageProbeStripVersion(base), key, nil
	case "volcengine":
		if config.AccessKeyID == "" || config.SecretAccessKey == "" {
			return nil, base, key, errors.New(apptext.T("火山方舟模板需要 Access Key ID 和 Secret Access Key"))
		}
		return usageProbeVolcengineCandidates(base, config), base, config.AccessKeyID, nil
	case "sub2api":
		general.parse = usageProbeParse{kind: "custom", resolver: "sub2api-usage"}
		return []usageProbeCandidate{general}, base, key, nil
	}
	var candidates []usageProbeCandidate
	// Builtin template IDs label recognition. Host/protocol restrictions remain
	// authoritative; choosing an ID never sends a key to an unrelated service.
	for _, candidate := range usageProbeBuiltinCandidates() {
		if usageProbeApplies(candidate, provider) {
			candidates = append(candidates, candidate)
		}
	}
	legacy, err := loadUsageProbeLegacy()
	if err != nil {
		return nil, base, key, err
	}
	for _, candidate := range legacy {
		if usageProbeApplies(candidate, provider) {
			candidates = append(candidates, candidate)
		}
	}
	return candidates, base, key, nil
}

var usageProbeVersionSuffix = regexp.MustCompile(`(?i)/v\d+(?:beta\d*)?/?$`)

func usageProbeStripVersion(base string) string {
	return usageProbeVersionSuffix.ReplaceAllString(strings.TrimRight(base, "/"), "")
}

func usageProbeURLs(candidate usageProbeCandidate, base string) ([]string, error) {
	if candidate.absoluteURL != "" {
		return []string{candidate.absoluteURL}, nil
	}
	if !usageProbeValidURL(base) || !usageProbeValidPath(candidate.path) {
		return nil, errors.New(apptext.T("用量查询地址或接口路径无效"))
	}
	base = strings.TrimRight(base, "/")
	if candidate.rootPath {
		u, _ := url.Parse(base)
		return []string{u.Scheme + "://" + u.Host + candidate.path}, nil
	}
	if candidate.noVersion || usageProbeVersionSuffix.MatchString(base) {
		return []string{base + candidate.path}, nil
	}
	return []string{base + "/v1" + candidate.path, base + candidate.path}, nil
}
