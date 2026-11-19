//go:build !js && !android && !ios

package workbench

// TokenDance (词元跳动) is the gateway the app offers as a built-in
// provider: one key covers the model catalog, the account's credit, and
// topping the account up. Nothing here stores the key; the settings page
// writes it into pi's own auth.json.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"example.com/pideck-lite/internal/apptext"
)

const (
	tokenDanceName       = "TokenDance"
	tokenDanceProvider   = "tokendance"
	tokenDanceBase       = "https://tokendance.space"
	tokenDanceGateway    = tokenDanceBase + "/gateway/v1"
	tokenDanceBalanceURL = tokenDanceBase + "/portal/api/v1/user/balance"
	tokenDancePayments   = tokenDanceBase + "/portal/api/v1/payment/sessions"
	// tokenDanceOpenAI is the protocol a pi model entry needs; the
	// platform also serves Anthropic, image, video and speech models,
	// which this provider cannot call.
	tokenDanceOpenAI = "openai:chat-completions"
	// tokenDanceSessionsPath is where the platform keeps payment sessions,
	// and the only path a status URL may point at.
	tokenDanceSessionsPath = "/portal/api/v1/payment/sessions"
	// tokenDanceAppURL is what the platform attributes calls to.
	tokenDanceAppURL = "https://pideck.caoayu.top/"
)

// tokenDanceRoot is the platform's address; a test points it elsewhere.
var tokenDanceRoot = tokenDanceBase

// tokenDanceModel is one entry of the platform's model catalog.
type tokenDanceModel struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	ContextLength int      `json:"context_length"`
	Protocols     []string `json:"supported_protocols"`
}

// tokenDanceBalance is an account's credit. Every amount is in 微元, and
// one yuan is a million of them.
type tokenDanceBalance struct {
	Credits int64 `json:"credits"`
	Used    int64 `json:"credits_used"`
	Left    int64 `json:"balance"`
}

// yuan renders 微元 as yuan.
func yuan(micro int64) string {
	return fmt.Sprintf("¥%.2f", float64(micro)/1e6)
}

// tokenDanceSession is one recharge payment session.
type tokenDanceSession struct {
	ID         string `json:"id"`
	Amount     int    `json:"amount"`
	Status     string `json:"status"`
	PaymentURL string `json:"payment_url"`
	AlipayURL  string `json:"alipay_url"`
	StatusURL  string `json:"status_url"`
	ExpiredAt  int64  `json:"expired_at"`
	CreatedAt  int64  `json:"created_at"`
	PaidAt     int64  `json:"paid_at"`
}

// settled says the session cannot change again.
func (s tokenDanceSession) settled() bool {
	switch s.Status {
	case "paid", "failed", "closed", "refunded": // set by the platform
		return true
	}
	return s.ExpiredAt > 0 && time.Now().Unix() > s.ExpiredAt
}

// tokenDanceError reads the platform's error body.
type tokenDanceError struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// tokenDanceDo sends one request and decodes the answer.
func tokenDanceDo(ctx context.Context, method, url, key string, body, out any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return err
	}
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := appHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var e tokenDanceError
		if json.Unmarshal(raw, &e) == nil && e.Error.Message != "" {
			return fmt.Errorf("%s（HTTP %d）", e.Error.Message, resp.StatusCode)
		}
		return fmt.Errorf("HTTP %d：%s", resp.StatusCode, shorten(string(raw), 200))
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("返回的不是预期的 JSON：%w", err)
	}
	return nil
}

// tokenDanceContext is a deadline for one call to the platform.
func tokenDanceContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 20*time.Second)
}

// fetchTokenDanceCatalog reads the platform's model catalog, which needs
// no key.
func fetchTokenDanceCatalog() ([]tokenDanceModel, error) {
	ctx, cancel := tokenDanceContext()
	defer cancel()
	var res struct {
		Data []tokenDanceModel `json:"data"`
	}
	if err := tokenDanceDo(ctx, http.MethodGet, tokenDanceRoot+"/gateway/v1/models", "", nil, &res); err != nil {
		return nil, err
	}
	sort.Slice(res.Data, func(i, j int) bool { return res.Data[i].ID < res.Data[j].ID })
	return res.Data, nil
}

// chatModels keeps the models this provider's API can call.
func chatModels(list []tokenDanceModel) []tokenDanceModel {
	var out []tokenDanceModel
	for _, m := range list {
		for _, p := range m.Protocols {
			if p == tokenDanceOpenAI {
				out = append(out, m)
				break
			}
		}
	}
	return out
}

// fetchTokenDanceBalance asks what the key's account has left.
func fetchTokenDanceBalance(key string) (tokenDanceBalance, error) {
	ctx, cancel := tokenDanceContext()
	defer cancel()
	var res struct {
		Balance tokenDanceBalance `json:"balance"`
	}
	if err := tokenDanceDo(ctx, http.MethodGet, tokenDanceRoot+"/portal/api/v1/user/balance", key, nil, &res); err != nil {
		return tokenDanceBalance{}, err
	}
	return res.Balance, nil
}

// createTokenDanceSession opens a payment session for an amount of yuan.
func createTokenDanceSession(key string, amount int) (tokenDanceSession, error) {
	ctx, cancel := tokenDanceContext()
	defer cancel()
	var res struct {
		Session tokenDanceSession `json:"session"`
	}
	err := tokenDanceDo(ctx, http.MethodPost, tokenDanceRoot+"/portal/api/v1/payment/sessions", key, map[string]any{"amount": amount}, &res)
	res.Session.StatusURL = tokenDanceStatusURL(res.Session.StatusURL, res.Session.ID)
	return res.Session, err
}

// tokenDanceStatusURL keeps the session's own query address on the
// platform: the key goes with that request, so another host is refused.
func tokenDanceStatusURL(raw, id string) string {
	if u, err := url.Parse(strings.TrimSpace(raw)); err == nil && u.Scheme == "https" &&
		u.Host == "tokendance.space" && strings.HasPrefix(u.Path, tokenDanceSessionsPath) {
		return u.String()
	}
	if id == "" {
		return ""
	}
	return tokenDanceRoot + tokenDanceSessionsPath + "/" + url.PathEscape(id)
}

// idFromStatusURL is the session id at the end of its query address.
func idFromStatusURL(statusURL string) string {
	u, err := url.Parse(strings.TrimSpace(statusURL))
	if err != nil {
		return ""
	}
	return strings.TrimSuffix(u.Path[strings.LastIndex(u.Path, "/")+1:], "/")
}

// fetchTokenDanceSession reads a session's status from its own URL.
func fetchTokenDanceSession(key, statusURL string) (tokenDanceSession, error) {
	if strings.TrimSpace(statusURL) == "" {
		return tokenDanceSession{}, fmt.Errorf("会话没有查询地址")
	}
	ctx, cancel := tokenDanceContext()
	defer cancel()
	var res struct {
		Session tokenDanceSession `json:"session"`
	}
	err := tokenDanceDo(ctx, http.MethodGet, statusURL, key, nil, &res)
	if res.Session.ID == "" {
		res.Session.ID = idFromStatusURL(statusURL)
	}
	res.Session.StatusURL = tokenDanceStatusURL(statusURL, res.Session.ID)
	return res.Session, err
}

// tokenDanceStatusLabel names a session's state.
func tokenDanceStatusLabel(s tokenDanceSession) string {
	switch s.Status {
	case "pending":
		return apptext.T("等待支付")
	case "paid":
		return apptext.T("已到账")
	case "failed":
		return apptext.T("支付失败")
	case "closed":
		return apptext.T("已关闭")
	case "refunded":
		return apptext.T("已退款")
	}
	return s.Status
}

// tokenDanceKey is the key the account calls use: pi's stored credential
// for the provider first, then the key in models.json. A key held by a
// command is pi's to run, so it reads as absent here.
func tokenDanceKey() string {
	if doc, err := readAuthDoc(); err == nil {
		if raw, ok := doc[tokenDanceProvider]; ok {
			var fields map[string]any
			if json.Unmarshal(raw, &fields) == nil {
				if key := strings.TrimSpace(strField(fields["key"])); key != "" {
					switch source, name := keyOrigin(key); source {
					case keyEnv:
						return strings.TrimSpace(os.Getenv(name))
					case keyCommand:
						return ""
					}
					return key
				}
			}
		}
	}
	for _, cfg := range readProviderConfigs() {
		if cfg.ID != tokenDanceProvider {
			continue
		}
		key := strings.TrimSpace(cfg.APIKey)
		if key == "" {
			return ""
		}
		if source, name := keyOrigin(key); source == keyEnv {
			return strings.TrimSpace(os.Getenv(name))
		} else if source == keyCommand {
			return ""
		}
		return key
	}
	return ""
}

// ensureTokenDanceProvider adds the built-in provider to models.json when
// it is not described there yet, with the compatibility flags this gateway
// needs. An existing entry is left exactly as the user has it.
func ensureTokenDanceProvider(apiKey string) error {
	path := modelsJSONPath()
	if path == "" {
		return fmt.Errorf("找不到 pi 的配置目录")
	}
	root := map[string]any{}
	if raw, err := os.ReadFile(path); err == nil {
		if len(bytes.TrimSpace(raw)) > 0 {
			if err := json.Unmarshal(raw, &root); err != nil {
				return fmt.Errorf("models.json 不是有效的 JSON：%w", err)
			}
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	providers, _ := root["providers"].(map[string]any)
	if providers == nil {
		providers = map[string]any{}
		root["providers"] = providers
	}
	apiKey = strings.TrimSpace(apiKey)
	entry, _ := providers[tokenDanceProvider].(map[string]any)
	changed := false
	if entry == nil {
		entry = map[string]any{
			"api":     "openai-completions",
			"baseUrl": tokenDanceGateway,
			"compat": map[string]any{
				"supportsDeveloperRole":                       false,
				"supportsReasoningEffort":                     true,
				"requiresReasoningContentOnAssistantMessages": true,
			},
			"headers": map[string]any{"X-App-URL": tokenDanceAppURL},
			"models":  []any{},
		}
		providers[tokenDanceProvider] = entry
		changed = true
	}
	// The key lives beside the provider, as pi's own editor writes it; a
	// blank one leaves whatever is stored alone.
	if apiKey != "" && strings.TrimSpace(strField(entry["apiKey"])) != apiKey {
		entry["apiKey"] = apiKey
		changed = true
	}
	if !changed {
		return nil
	}
	data, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(path, append(data, '\n'), 0o600)
}

// tokenDanceMerge merges the catalog's chat models into a provider's
// entries: a model that is already there keeps its own fields and takes
// only the name and context window the catalog states. Entries the
// platform no longer lists stay, so nothing the user added is dropped.
func tokenDanceMerge(existing []modelConfig, catalog []tokenDanceModel) (merged []modelConfig, added, updated, kept int) {
	byID := map[string]modelConfig{}
	for _, m := range existing {
		byID[m.ID] = m
	}
	listed := map[string]bool{}
	for _, m := range catalog {
		listed[m.ID] = true
	}
	for _, m := range existing {
		if !listed[m.ID] {
			kept++
		}
	}
	seen := map[string]bool{}
	merged = append(merged, existing...)
	for _, m := range catalog {
		if m.ID == "" || seen[m.ID] {
			continue
		}
		seen[m.ID] = true
		if _, ok := byID[m.ID]; !ok {
			fresh := modelConfig{ID: m.ID, Name: m.Name}
			if m.ContextLength > 0 {
				fresh.ContextWindow = m.ContextLength
			}
			merged = append(merged, fresh)
			added++
			continue
		}
		for i := range merged {
			if merged[i].ID != m.ID {
				continue
			}
			if m.Name != "" && merged[i].Name != m.Name {
				merged[i].Name = m.Name
				updated++
			}
			if m.ContextLength > 0 && merged[i].ContextWindow != m.ContextLength {
				merged[i].ContextWindow = m.ContextLength
				updated++
			}
			break
		}
	}
	return merged, added, updated, kept
}
