//go:build !js && !android && !ios

package workbench

import (
	"context"
	"encoding/base64"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"time"

	"example.com/pideck/internal/apptext"
)

type usageProbePanelSession struct {
	gate                     chan struct{}
	beforeJWT, beforeRefresh string
	afterJWT, afterRefresh   string
}

var usageProbePanelSessions sync.Map

func usageProbePanelNeedsRefresh(token string, now time.Time) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	value, err := usageProbeDecodeJSON(payload)
	if err != nil {
		return false
	}
	exp := usageProbeEpoch(usageProbeGet(value, "exp"), false)
	return !exp.IsZero() && !exp.After(now.Add(time.Minute))
}

func usageProbePanelBalance(ctx context.Context, client *http.Client, provider, base string, config usageProbeConfig) (*float64, string) {
	const balancePath = "/api/v1/auth/me"
	balanceURLs, err := usageProbeURLs(usageProbeCandidate{path: balancePath, rootPath: true}, base)
	if err != nil {
		return nil, apptext.T("面板余额查询失败，主用量不受影响")
	}
	refreshURLs, _ := usageProbeURLs(usageProbeCandidate{path: "/api/v1/auth/refresh", rootPath: true}, base)
	key := usageProbeConfigPath() + "\x00" + provider + "\x00" + base
	created := &usageProbePanelSession{gate: make(chan struct{}, 1)}
	created.gate <- struct{}{}
	actual, _ := usageProbePanelSessions.LoadOrStore(key, created)
	session := actual.(*usageProbePanelSession)
	select {
	case <-ctx.Done():
		return nil, apptext.T("面板余额查询失败，主用量不受影响")
	case <-session.gate:
	}
	defer func() { session.gate <- struct{}{} }()
	jwt, refresh := config.PanelJWT, config.PanelRefreshToken
	// A queued query may still hold the token that the preceding query just
	// rotated. Reuse that exact pair's successor; never substitute a draft pair.
	if jwt == session.beforeJWT && refresh == session.beforeRefresh && session.afterJWT != "" {
		jwt, refresh = session.afterJWT, session.afterRefresh
	}
	attempted, persistFailed := false, false
	refreshOnce := func() bool {
		if attempted || refresh == "" {
			return false
		}
		attempted = true
		headers := make(http.Header)
		headers.Set("Accept", "application/json")
		body, _, err := usageProbeRequest(ctx, client, http.MethodPost, refreshURLs[0], headers, map[string]string{"refresh_token": refresh})
		if err != nil {
			return false
		}
		data := usageProbeObject(usageProbeGet(body, "data"))
		if data == nil {
			data = usageProbeObject(body)
		}
		next := usageProbeString(data["access_token"])
		if next == "" {
			return false
		}
		nextRefresh := usageProbeString(data["refresh_token"])
		if nextRefresh == "" {
			nextRefresh = refresh
		}
		session.beforeJWT, session.beforeRefresh = jwt, refresh
		session.afterJWT, session.afterRefresh = next, nextRefresh
		jwt, refresh = next, nextRefresh
		persistFailed = usageProbePersistPanelTokens(provider, config, jwt, refresh) != nil
		return true
	}
	if usageProbePanelNeedsRefresh(jwt, time.Now()) {
		refreshOnce()
	}
	headers := make(http.Header)
	headers.Set("Accept", "application/json")
	requestProfile := func() (any, int, error) {
		headers.Set("Authorization", "Bearer "+jwt)
		return usageProbeRequest(ctx, client, http.MethodGet, balanceURLs[0], headers, nil)
	}
	body, status, err := requestProfile()
	if status == http.StatusUnauthorized && refreshOnce() {
		body, status, err = requestProfile()
	}
	if err == nil {
		if balance := usageProbeN(body, "data.balance"); balance != nil {
			if persistFailed {
				return balance, apptext.T("面板登录态已续期，但保存失败，请重新保存配置")
			}
			return balance, ""
		}
	}
	if status == http.StatusUnauthorized {
		return nil, apptext.T("面板登录态已失效，请更新登录凭据")
	}
	return nil, apptext.T("面板余额查询失败，主用量不受影响")
}

func usageProbePersistPanelTokens(provider string, before usageProbeConfig, jwt, refresh string) error {
	usageProbeConfigMu.Lock()
	defer usageProbeConfigMu.Unlock()
	doc, err := readUsageProbeDocument()
	if err != nil {
		return err
	}
	providers, _ := doc["providers"].(map[string]any)
	entry, exists := providers[provider]
	if !exists {
		return nil // A test/draft must not create a saved configuration.
	}
	current, err := decodeUsageProbeConfig(entry)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(current, before) {
		return nil // Settings were edited or this is an unsaved test draft.
	}
	fields := entry.(map[string]any)
	fields["panelJwt"], fields["panelRefreshToken"] = jwt, refresh
	return writeUsageProbeDocument(doc)
}
