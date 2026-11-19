//go:build !js && !android && !ios

package workbench

// The small LLM calls behind the app's tools: a commit message, a stronger
// prompt, a predicted continuation. Each tool picks its own provider and
// model in the settings; the calls are plain chat completions, not the
// agent's session.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// toolModelCfg is one tool's provider and model, empty while not enabled.
type toolModelCfg struct {
	Provider string `json:"provider,omitempty"`
	Model    string `json:"model,omitempty"`
}

// toolNames are the tools that choose a model of their own.
var toolNames = []string{"commit", "prompt", "predict"}

// toolModel is a tool's provider and model, the first model when only the
// provider was chosen.
func (a *app) toolModel(tool string) (providerConfig, modelConfig, error) {
	cfg, ok := a.cfg.ToolModels[tool]
	if !ok || strings.TrimSpace(cfg.Provider) == "" {
		return providerConfig{}, modelConfig{}, errors.New("这个工具还没有配置模型")
	}
	for _, p := range readProviderConfigs() {
		if p.ID != cfg.Provider {
			continue
		}
		for _, m := range p.Models {
			if m.ID == cfg.Model {
				return p, m, nil
			}
		}
		if cfg.Model == "" && len(p.Models) > 0 {
			return p, p.Models[0], nil
		}
		return p, modelConfig{}, errors.New("所选的模型不在这个供应商里")
	}
	return providerConfig{}, modelConfig{}, errors.New("找不到所选的供应商")
}

// draftTools are the composer's draft tools, in the order the phone lists
// them.
var draftTools = []string{"prompt", "predict"}

// toolSystem is the instruction a draft tool's model runs.
func toolSystem(tool string) string {
	switch tool {
	case "prompt":
		return "你是提示词润色助手。把用户的草稿改写成更清晰、具体、可执行的提示词；保留原意、语言和约束，不添加无关要求。只输出改写后的提示词。"
	case "predict":
		return "续写用户正在输入的消息，只写接下来的一个短句或半句，与已有文字自然衔接；不要重复已有内容，不要解释。只输出续写部分。"
	}
	return ""
}

// toolTokens is how much of an answer a draft tool may take.
func toolTokens(tool string) int {
	if tool == "predict" {
		return 160
	}
	return 900
}

// remoteDraftTools lists the draft tools the desktop can run for a phone.
func (a *app) remoteDraftTools() []string {
	var out []string
	for _, tool := range draftTools {
		if a.toolConfigured(tool) {
			out = append(out, tool)
		}
	}
	return out
}

// toolConfigured says whether a tool has a provider and a model to call.
func (a *app) toolConfigured(tool string) bool {
	_, _, err := a.toolModel(tool)
	return err == nil
}

// setToolModel stores a tool's provider and model, and clears it for an
// empty provider.
func (a *app) setToolModel(tool, provider, model string) {
	if a.cfg.ToolModels == nil {
		a.cfg.ToolModels = map[string]toolModelCfg{}
	}
	provider, model = strings.TrimSpace(provider), strings.TrimSpace(model)
	if provider == "" {
		delete(a.cfg.ToolModels, tool)
	} else {
		a.cfg.ToolModels[tool] = toolModelCfg{Provider: provider, Model: model}
	}
	if a.st != nil {
		a.st.edit(func(c *config) {
			if c.ToolModels == nil {
				c.ToolModels = map[string]toolModelCfg{}
			}
			if provider == "" {
				delete(c.ToolModels, tool)
			} else {
				c.ToolModels[tool] = toolModelCfg{Provider: provider, Model: model}
			}
		})
	}
	a.toolRev.Update(func(n int) int { return n + 1 })
}

// complete asks a tool's model. Tests replace llmFn with a fake.
func (a *app) complete(tool, system, prompt string, maxTokens int) (string, error) {
	if a.llmFn != nil {
		return a.llmFn(tool, system, prompt, maxTokens)
	}
	return a.llmComplete(context.Background(), tool, system, prompt, maxTokens)
}

// llmComplete runs one chat completion with the tool's provider.
func (a *app) llmComplete(ctx context.Context, tool, system, prompt string, maxTokens int) (string, error) {
	provider, model, err := a.toolModel(tool)
	if err != nil {
		return "", err
	}
	if maxTokens <= 0 {
		maxTokens = 512
	}
	key := providerKey(provider)
	if strings.Contains(strings.ToLower(provider.API), "anthropic") {
		return llmAnthropic(ctx, provider, model, key, system, prompt, maxTokens)
	}
	return llmOpenAI(ctx, provider, model, key, system, prompt, maxTokens)
}

// llmOpenAI calls an OpenAI-compatible chat completion.
func llmOpenAI(ctx context.Context, provider providerConfig, model modelConfig, key, system, prompt string, maxTokens int) (string, error) {
	base := strings.TrimRight(strings.TrimSpace(provider.BaseURL), "/")
	if base == "" {
		return "", errors.New("供应商没有 Base URL")
	}
	url := base + "/chat/completions"
	if strings.HasSuffix(base, "/chat/completions") {
		url = base
	}
	payload := map[string]any{
		"model": model.ID,
		"messages": []map[string]string{
			{"role": "system", "content": system},
			{"role": "user", "content": prompt},
		},
		"max_tokens": maxTokens,
	}
	body, status, err := llmPost(ctx, url, payload, key, nil)
	if err != nil {
		return "", err
	}
	if status < 200 || status >= 300 {
		return "", fmt.Errorf("HTTP %d：%s", status, shorten(string(body), 240))
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", fmt.Errorf("读不懂模型返回：%w", err)
	}
	if len(out.Choices) == 0 {
		return "", errors.New("模型没有返回内容")
	}
	text := contentText(out.Choices[0].Message.Content)
	if strings.TrimSpace(text) == "" {
		return "", errors.New("模型返回了空内容")
	}
	return text, nil
}

// contentText reads content that is a string, or parts each with text.
func contentText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var parts []struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) == nil {
		var b strings.Builder
		for _, p := range parts {
			b.WriteString(p.Text)
		}
		return b.String()
	}
	return ""
}

// llmAnthropic calls an Anthropic messages completion.
func llmAnthropic(ctx context.Context, provider providerConfig, model modelConfig, key, system, prompt string, maxTokens int) (string, error) {
	base := strings.TrimRight(strings.TrimSpace(provider.BaseURL), "/")
	if base == "" {
		return "", errors.New("供应商没有 Base URL")
	}
	url := base + "/v1/messages"
	switch {
	case strings.HasSuffix(base, "/messages"):
		url = base
	case strings.HasSuffix(base, "/v1"):
		url = base + "/messages"
	}
	payload := map[string]any{
		"model":      model.ID,
		"max_tokens": maxTokens,
		"system":     system,
		"messages":   []map[string]string{{"role": "user", "content": prompt}},
	}
	body, status, err := llmPost(ctx, url, payload, key, map[string]string{"anthropic-version": "2023-06-01"})
	if err != nil {
		return "", err
	}
	if status < 200 || status >= 300 {
		return "", fmt.Errorf("HTTP %d：%s", status, shorten(string(body), 240))
	}
	var out struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", fmt.Errorf("读不懂模型返回：%w", err)
	}
	var b strings.Builder
	for _, part := range out.Content {
		if part.Type == "" || part.Type == "text" {
			b.WriteString(part.Text)
		}
	}
	if strings.TrimSpace(b.String()) == "" {
		return "", errors.New("模型返回了空内容")
	}
	return b.String(), nil
}

// cleanLLMText strips the code fences and outer quotes some models add.
func cleanLLMText(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		if i := strings.IndexByte(s, '\n'); i >= 0 {
			s = s[i+1:]
		}
		s = strings.TrimSuffix(strings.TrimSpace(s), "```")
	}
	return strings.TrimSpace(strings.Trim(s, "`\"' \n"))
}

// llmPost sends one JSON request with the app's long-lived HTTP client.
func llmPost(ctx context.Context, url string, payload any, key string, extra map[string]string) ([]byte, int, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, 0, err
	}
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("x-api-key", key)
	}
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	resp, err := appHTTPLongClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return body, resp.StatusCode, nil
}
