//go:build !js && !android && !ios

package workbench

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestProviderManagerFetchRetryAndRenameJourney(t *testing.T) {
	a, screen := startNativeSettingsApp(t)
	var reject atomic.Bool
	reject.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-key" {
			t.Error("request did not use the configured fixture key")
		}
		w.Header().Set("Content-Type", "application/json")
		if reject.Load() {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"fixture-key must never appear in UI errors"}`))
			return
		}
		if r.URL.Path == "/balance" {
			_, _ = w.Write([]byte(`{"data":{"balance":5,"currency":"CNY"}}`))
			return
		}
		if r.Method == http.MethodPost {
			_, _ = w.Write([]byte(`{}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"remote-a","name":"Alpha chat"},{"id":"remote-b","name":"Beta chat"},{"id":"remote-unused","name":"Not selected"}]}`))
	}))
	defer server.Close()
	cfg := readProviderConfigs()[0]
	cfg.BaseURL, cfg.APIKey = server.URL+"/v1", "fixture-key"
	if err := writeProviderConfig(cfg, false); err != nil {
		t.Fatal(err)
	}
	onNativeUI(t, screen, a, func() { a.openSettingsPane(); a.openSettingsSection("models") })
	screen.WaitFor("id:provider-manage-models-fixture", 5*time.Second)
	screen.Press("id:provider-manage-models-fixture")
	screen.WaitFor("id:provider-fetch-models-fixture", 5*time.Second)
	screen.Press("id:provider-fetch-models-fixture")
	screen.WaitUntil(5*time.Second, func() bool { return !a.providerFetchBusy.GetUntracked() && a.providerFetchError.GetUntracked() != "" })
	onNativeUI(t, screen, a, func() {
		if strings.Contains(a.providerFetchError.GetUntracked(), "fixture-key") {
			t.Error("fetch error leaked a key")
		}
	})
	reject.Store(false)
	screen.Press("id:provider-fetch-models-fixture")
	screen.WaitFor("id:provider-fetched-model-fixture-remote-a", 5*time.Second)
	screen.Press("id:provider-fetched-model-fixture-remote-a")
	screen.Type("id:provider-fetched-filter-fixture", "Beta")
	screen.Press("id:provider-fetched-model-fixture-remote-b")
	screen.WaitFor("text:已选 2 个；搜索不会清除已选项。仅添加勾选的模型。", 5*time.Second)
	shot(screen, "provider-manager/remote-selection")
	screen.Press("id:provider-fetched-add-fixture")
	screen.WaitFor("id:provider-model-remote-a", 5*time.Second)
	screen.WaitFor("id:provider-model-remote-b", 5*time.Second)
	got := readProviderConfigs()[0].Models
	if len(got) != 3 || got[0].ID != "fixture-chat" || got[1].ID != "remote-a" || got[2].ID != "remote-b" {
		t.Fatalf("selected models = %+v; want original plus the two explicit selections", got)
	}
	screen.Press("id:provider-model-test-remote-a")
	screen.WaitUntil(5*time.Second, func() bool { return strings.Contains(a.providerTest.GetUntracked(), "HTTP 200") })
	screen.Press("id:provider-tab-usage")
	screen.WaitFor("id:provider-usage-enabled", 5*time.Second)
	screen.Press("id:provider-usage-enabled")
	screen.Press("id:provider-usage-template")
	screen.Press("role:option 通用余额接口")
	screen.Type("id:provider-usage-baseUrl", server.URL+"/balance")
	screen.Type("id:provider-usage-valuePath", "data.balance")
	screen.Type("id:provider-usage-currencyPath", "data.currency")
	screen.Clear("id:provider-usage-timeout")
	screen.Type("id:provider-usage-timeout", "0")
	screen.Press("id:provider-balance")
	screen.WaitFor("text:超时必须是 1 到 300 秒的整数。", 5*time.Second)
	screen.Clear("id:provider-usage-timeout")
	screen.Type("id:provider-usage-timeout", "5")
	screen.Clear("id:provider-usage-interval")
	screen.Type("id:provider-usage-interval", "0")
	screen.Press("id:provider-balance")
	screen.WaitFor("text:余额 5.00 CNY", 5*time.Second)
	shot(screen, "provider-manager/usage-query")
	if _, saved, err := loadUsageProbeConfig("fixture"); err != nil || saved {
		t.Fatalf("testing an unsaved usage draft persisted it: saved=%v, err=%v", saved, err)
	}
	screen.Press("id:provider-usage-save")
	screen.WaitFor("text:用量配置已保存", 5*time.Second)
	usage, saved, err := loadUsageProbeConfig("fixture")
	if err != nil || !saved || usage.Template != "general" || usage.IntervalMinutes == nil || *usage.IntervalMinutes != 0 {
		t.Fatalf("saved usage settings = %+v, saved=%v, err=%v", usage, saved, err)
	}
	connection, _, _, err := readProviderConnection("fixture")
	if err != nil || connection.BaseURL != cfg.BaseURL || connection.APIKey != cfg.APIKey {
		t.Fatalf("usage save changed chat connection: %+v, %v", connection, err)
	}
	screen.Press("id:provider-tab-connection")
	screen.WaitFor("id:provider-advanced", 5*time.Second)
	screen.Press("id:provider-advanced")
	screen.WaitFor("id:provider-rename-id", 5*time.Second)
	screen.Clear("id:provider-rename-id")
	screen.Type("id:provider-rename-id", "renamed-provider")
	screen.Press("id:provider-rename-save")
	screen.WaitFor("id:confirm-ok", 5*time.Second)
	screen.Press("id:confirm-ok")
	screen.WaitUntil(5*time.Second, func() bool { return providerConfigured("renamed-provider") && !providerConfigured("fixture") })
	screen.WaitFor("text:供应商已重命名", 5*time.Second)
	screen.Press("id:provider-cancel")
	screen.WaitForGone("id:provider-dialog", 5*time.Second)
	screen.WaitFor("id:provider-expand-renamed-provider", 5*time.Second)
	screen.Press("id:provider-expand-renamed-provider")
	screen.Press("id:provider-clone-renamed-provider")
	screen.WaitFor("id:confirm-ok", 5*time.Second)
	screen.Press("id:confirm-ok")
	screen.WaitFor("text:供应商已复制", 5*time.Second)
	screen.Press("id:provider-cancel")
	screen.WaitForGone("id:provider-dialog", 5*time.Second)
	screen.WaitFor("id:provider-select-renamed-provider-copy", 5*time.Second)
	screen.Press("id:provider-select-renamed-provider-copy")
	screen.Press("id:provider-delete-selected")
	screen.WaitFor("id:confirm-ok", 5*time.Second)
	screen.Press("id:confirm-ok")
	screen.WaitUntil(5*time.Second, func() bool { return !providerConfigured("renamed-provider-copy") })
	if !providerConfigured("renamed-provider") {
		t.Fatal("deleting the copy removed the source provider")
	}
}
