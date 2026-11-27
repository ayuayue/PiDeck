//go:build !js && !android && !ios

package workbench

import (
	"archive/zip"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestNativeSettingsPageScreens captures the settings sections most likely
// to differ across window sizes. All config files live in this test's temp
// directories; screenshots contain no real provider credentials.
func TestNativeSettingsPageScreens(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native screenshot fixture")
	}
	built, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, built, func() {
		built.openSettingsPane()
		built.settingsTab.Set("general")
	})
	screen.WaitFor("id:settings-search", 10*time.Second)
	sections := settingsSections()
	for _, section := range sections {
		id := section.ID
		onNativeUI(t, screen, built, func() {
			if id == "remote" || id == "mcp" {
				// Keep screenshot capture isolated: remote probes touch the local
				// network and MCP discovery may launch configured user processes.
				built.settingsTab.Set(id)
				built.settingsQuery.Set("")
				built.forgetScrolls("settings")
			} else {
				built.openSettingsSection(id)
			}
			if id == "models" {
				built.providers.Set(settingsProviderFixture())
			}
		})
		switch id {
		case "models":
			screen.WaitFor("id:settings-content", 5*time.Second)
			screen.WaitFor("id:provider-add", 5*time.Second)
		case "credentials":
			screen.WaitFor("id:settings-page", 5*time.Second)
			screen.WaitFor("id:auth-add", 5*time.Second)
		case "usage":
			screen.WaitUntil(5*time.Second, func() bool { return len(screen.Query("text:还没有可统计的用量")) > 0 })
		default:
			screen.WaitFor("id:settings-page", 5*time.Second)
		}
		screen.Advance(120 * time.Millisecond)
		shot(screen, "comparison/settings-"+id)
	}
	onNativeUI(t, screen, built, func() {
		built.theme.Set("dark")
		built.applyTheme()
		built.openSettingsSection("general")
	})
	screen.WaitFor("id:language-select", 5*time.Second)
	shot(screen, "comparison/settings-general-dark")
	screen.Resize(900, 560)
	onNativeUI(t, screen, built, func() { built.openSettingsSection("general") })
	screen.WaitFor("id:language-select", 5*time.Second)
	shot(screen, "comparison/settings-general-narrow")
}

func TestNativeLanguageMenuScreen(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native screenshot fixture")
	}
	built, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, built, func() {
		built.openSettingsPane()
		built.openSettingsSection("general")
	})
	screen.WaitFor("id:language-select", 10*time.Second)
	screen.Press("id:language-select")
	screen.WaitFor("id:language-select-1", 5*time.Second)
	shot(screen, "comparison/settings-language-menu")
}

func TestNativeAuthKeyDialogScreen(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native screenshot fixture")
	}
	built, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, built, func() {
		built.openSettingsPane()
		built.openSettingsSection("credentials")
	})
	screen.Press("id:auth-add-custom")
	screen.WaitFor("id:auth-key", 5*time.Second)
	shot(screen, "comparison/auth-key-dialog")
}

func TestNativeMCPDialogScreen(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native screenshot fixture")
	}
	built, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, built, func() {
		built.openSettingsPane()
		built.settingsTab.Set("mcp")
		built.mcpAddOpen.Set(true)
	})
	screen.WaitFor("id:mcp-dialog", 5*time.Second)
	shot(screen, "comparison/mcp-dialog")
}

func TestNativeSettingsImportConfirmScreen(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native screenshot fixture")
	}
	built, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, built, func() {
		built.openSettingsPane()
		built.settingsTab.Set("data")
	})
	backupPath := filepath.Join(t.TempDir(), "settings.zip")
	backupFile, err := os.Create(backupPath)
	if err != nil {
		t.Fatal(err)
	}
	backup := zip.NewWriter(backupFile)
	entry, err := backup.Create("config.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entry.Write([]byte(`{"version":3}`)); err != nil {
		t.Fatal(err)
	}
	if err := backup.Close(); err != nil {
		t.Fatal(err)
	}
	if err := backupFile.Close(); err != nil {
		t.Fatal(err)
	}
	onNativeUI(t, screen, built, func() { built.importSettings(backupPath) })
	screen.WaitFor("id:confirm", 5*time.Second)
	shot(screen, "comparison/settings-import-confirm")
}

func TestNativeProviderConfigScreen(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native screenshot fixture")
	}
	built, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, built, func() {
		built.openSettingsPane()
		built.settingsTab.Set("models")
		built.providers.Set(settingsProviderFixture())
	})
	screen.WaitFor("id:provider-configure-fixture", 5*time.Second)
	screen.Press("id:provider-configure-fixture")
	screen.WaitFor("id:provider-dialog", 5*time.Second)
	shot(screen, "comparison/provider-config")
	screen.Scroll("id:provider-scroll", 220)
	shot(screen, "comparison/provider-config-scrolled")
	screen.Press("id:provider-cancel")
	screen.Advance(250 * time.Millisecond)
	screen.WaitForGone("id:provider-dialog", 5*time.Second)
}

func TestProviderCreateFromSettings(t *testing.T) {
	built, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, built, func() { built.openSettingsPane() })
	screen.Press("id:settings-tab-models")
	screen.Press("id:provider-add")
	screen.WaitFor("id:provider-add-dialog", 5*time.Second)
	shot(screen, "comparison/provider-add")
	screen.Type("id:provider-add-id", "discard-fixture")
	screen.Press("id:provider-add-cancel")
	screen.Advance(250 * time.Millisecond)
	screen.WaitForGone("id:provider-add-dialog", 5*time.Second)
	screen.Press("id:provider-add")
	screen.WaitFor("id:provider-add-dialog", 5*time.Second)
	if providerConfigured("discard-fixture") {
		t.Fatal("cancel wrote the unfinished provider")
	}
	screen.Press("id:provider-add-save")
	screen.WaitFor("id:provider-add-error", 5*time.Second)
	screen.Type("id:provider-add-id", "fixture")
	screen.Type("id:provider-add-base", "https://api.example.invalid/v1")
	screen.Press("id:provider-add-save")
	screen.WaitFor("text:供应商 ID 已存在。请打开现有供应商进行配置。", 5*time.Second)
	screen.Clear("id:provider-add-id")
	screen.Type("id:provider-add-id", "new-provider")
	screen.Clear("id:provider-add-base")
	screen.Type("id:provider-add-base", "file:///example")
	screen.Press("id:provider-add-save")
	screen.WaitFor("text:请输入有效的 HTTP 或 HTTPS 地址。", 5*time.Second)
	screen.Clear("id:provider-add-base")
	screen.Type("id:provider-add-base", "https://api.example.invalid/v1")
	screen.Press("id:provider-add-save")
	screen.WaitFor("text:已添加供应商", 15*time.Second)
	screen.Advance(250 * time.Millisecond)
	screen.WaitForGone("id:provider-add-dialog", 5*time.Second)
	byID := make(map[string]providerConfig)
	for _, cfg := range readProviderConfigs() {
		byID[cfg.ID] = cfg
	}
	if got := byID["fixture"].Models; len(got) != 1 || got[0].ID != "fixture-chat" {
		t.Fatalf("original provider models = %v, want fixture-chat", got)
	}
	got := byID["new-provider"]
	if got.BaseURL != "https://api.example.invalid/v1" || got.API != "openai-completions" || len(got.Models) != 0 {
		t.Fatalf("created provider = %+v, want empty model list", got)
	}
	screen.WaitFor("id:provider-configure-new-provider", 15*time.Second)
	onNativeUI(t, screen, built, func() { built.openSettingsSection("general") })
	screen.WaitFor("id:default-model-provider", 5*time.Second)
	screen.Press("id:default-model-provider")
	screen.WaitFor("role:option fixture", 5*time.Second)
	screen.Press("role:option fixture")
	screen.Press("id:default-model-select")
	screen.WaitFor("role:option Fixture Chat", 5*time.Second)
	screen.Press("role:option Fixture Chat")
	onNativeUI(t, screen, built, func() {
		if got := built.st.config().Model; got.Provider != "fixture" || got.ID != "fixture-chat" {
			t.Errorf("default model = %+v, want fixture/fixture-chat", got)
		}
		built.openSettingsSection("models")
	})
	screen.Type("id:provider-filter", "new-provider")
	screen.WaitForGone("id:provider-configure-fixture", 5*time.Second)
	screen.Find("id:provider-configure-new-provider")
	screen.Clear("id:provider-filter")
	screen.WaitFor("id:provider-configure-fixture", 5*time.Second)
	screen.Focus("id:settings-tab-models")
	screen.Key("down")
	screen.WaitFor("id:auth-add", 5*time.Second)
	screen.Key("down")
	screen.WaitFor("id:pi-hide-thinking", 5*time.Second)
}

func TestDefaultModelSettingsSearch(t *testing.T) {
	for _, query := range []string{"默认模型", "default model"} {
		hits := searchSettings(query)
		if len(hits) != 1 || hits[0].Section != "general" || hits[0].Label != "新会话默认模型" || hits[0].Jump {
			t.Fatalf("searchSettings(%q) = %+v, want the default model setting in general", query, hits)
		}
	}
	built, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, built, built.openSettingsPane)
	screen.Type("id:settings-search", "默认模型")
	screen.WaitFor("id:settings-hit-general-0", 5*time.Second)
	screen.Press("id:settings-hit-general-0")
	screen.WaitFor("id:default-model-provider", 5*time.Second)
	screen.Find("id:default-model-select")
}

func settingsProviderFixture() []providerInfo {
	return []providerInfo{{ID: "fixture", API: "openai-completions", BaseURL: "https://api.example.invalid/v1",
		Models: []modelConfig{{ID: "fixture-chat", Name: "Fixture Chat"}}, Configured: true, Auth: "not_ready"}}
}

func startNativeSettingsApp(t *testing.T) (*app, *nsgotest.App) {
	t.Helper()
	home, piConfig := t.TempDir(), t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PIDECK_V2_PI_CONFIG", piConfig)
	t.Setenv("PIDECK_V2_LANG", "zh-CN")
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"scanPi":false,"telemetryEnabled":false,"autoModelCatalog":false,"theme":"light"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	models := `{"providers":{"fixture":{"api":"openai-completions","baseUrl":"https://api.example.invalid/v1","models":[{"id":"fixture-chat","name":"Fixture Chat","contextWindow":32768,"maxTokens":4096,"reasoning":true,"input":["text"]}]}}}`
	if err := os.WriteFile(filepath.Join(piConfig, "models.json"), []byte(models), 0o600); err != nil {
		t.Fatal(err)
	}
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}, nsgotest.Size(1520, 920), nsgotest.Environment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop}))
	t.Cleanup(built.closeDiag)
	return built, screen
}
