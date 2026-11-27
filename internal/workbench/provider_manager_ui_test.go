//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProviderManagerImportExportJourney(t *testing.T) {
	a, screen := startNativeSettingsApp(t)
	defer func() {
		if t.Failed() {
			h := a.providerManager
			t.Logf("transfer state: open=%v mode=%q seq=%d textlen=%d error=%q ids=%v busy=%v", a.providerOpen.GetUntracked(), h.transfer.GetUntracked(), h.loadSeq, len(h.transferForm.text.GetUntracked()), h.transferForm.problem.GetUntracked(), h.transferForm.ids, h.transferForm.busy.GetUntracked())
		}
	}()
	onNativeUI(t, screen, a, func() { a.openSettingsPane(); a.openSettingsSection("models") })
	screen.WaitFor("id:provider-import", 5*time.Second)
	screen.Press("id:provider-import")
	screen.WaitFor("id:provider-transfer-json", 5*time.Second)
	screen.Type("id:provider-transfer-json", `{"providers":{"journey":{"api":"openai-completions","baseUrl":"https://example.invalid/v1","apiKey":"fixture-secret","models":[{"id":"journey/chat","name":"Journey Chat","contextWindow":64000,"maxTokens":4096}]}}}`)
	screen.Press("id:provider-import-preview")
	screen.WaitFor("text:供应商：journey；模型：1；同名冲突：0", 5*time.Second)
	screen.Press("id:provider-import-save")
	screen.WaitForGone("id:provider-transfer-dialog", 5*time.Second)
	screen.WaitFor("id:provider-configure-journey", 5*time.Second)
	screen.Press("id:provider-select-journey")
	screen.Press("id:provider-export-selected")
	screen.WaitFor("id:provider-export-copy", 5*time.Second)
	screen.WaitUntil(5*time.Second, func() bool { return a.providerManager.transferForm.text.GetUntracked() != "" })
	onNativeUI(t, screen, a, func() {
		out := a.providerManager.transferForm.text.GetUntracked()
		if strings.Contains(out, "fixture-secret") {
			t.Error("default export leaked API key")
		}
		if !strings.Contains(out, "journey/chat") {
			t.Error("export lost selected model")
		}
	})
	screen.Press("id:provider-transfer-close")
	screen.Press("id:provider-delete-selected")
	screen.WaitFor("id:confirm-ok", 5*time.Second)
	screen.Press("id:confirm-ok")
	screen.WaitUntil(5*time.Second, func() bool { return !providerConfigured("journey") })
	if !providerConfigured("fixture") {
		t.Fatal("batch delete removed unselected provider")
	}
}

func TestProviderManagerAdvancedAndPreferencesJourney(t *testing.T) {
	a, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, a, func() { a.openSettingsPane(); a.openSettingsSection("models") })
	screen.WaitFor("id:provider-manage-models-fixture", 5*time.Second)
	screen.Press("id:provider-manage-models-fixture")
	screen.WaitFor("id:provider-model-favorite-fixture-chat", 5*time.Second)
	screen.Press("id:provider-model-favorite-fixture-chat")
	screen.Press("id:provider-model-default-fixture-chat")
	screen.Press("id:provider-model-more-fixture-chat")
	screen.Press("id:provider-model-hidden-fixture-chat")
	onNativeUI(t, screen, a, func() {
		if !a.modelHidden("fixture", "fixture-chat") {
			t.Error("hide action did not persist")
		}
		if a.defaultModel.ID != "fixture-chat" {
			t.Error("set default failed")
		}
	})
	screen.Press("id:provider-model-advanced-fixture-chat")
	screen.WaitFor("id:provider-model-user-agent", 5*time.Second)
	screen.Type("id:provider-model-user-agent", "Fixture-Agent/1")
	screen.Press("id:provider-model-thinking-xhigh")
	screen.Press("id:provider-model-tier-add")
	screen.Type("id:provider-model-tier-0-inputTokensAbove", "100000")
	screen.Clear("id:provider-model-tier-0-input")
	screen.Type("id:provider-model-tier-0-input", "2.5")
	screen.Press("id:provider-model-advanced-save")
	screen.WaitFor("id:provider-model-fixture-chat", 5*time.Second)
	cfg, err := readModelAdvanced("fixture", "fixture-chat")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.UserAgent != "Fixture-Agent/1" || cfg.ThinkingLevelMap["xhigh"] != "xhigh" || len(cfg.Tiers) != 1 {
		t.Fatalf("advanced settings = %+v", cfg)
	}
	screen.Press("id:provider-model-fixture-chat")
	screen.WaitFor("id:provider-model-id", 5*time.Second)
	screen.Clear("id:provider-model-id")
	screen.Type("id:provider-model-id", "renamed-chat")
	screen.Press("id:provider-model-save")
	screen.WaitFor("id:provider-model-renamed-chat", 5*time.Second)
	cfg, err = readModelAdvanced("fixture", "renamed-chat")
	if err != nil || cfg.UserAgent != "Fixture-Agent/1" {
		t.Fatalf("rename lost UA: %+v, %v", cfg, err)
	}
	onNativeUI(t, screen, a, func() {
		if a.defaultModel.ID != "renamed-chat" || !a.modelHidden("fixture", "renamed-chat") {
			t.Error("rename left stale preferences")
		}
		if got := a.favModels.GetUntracked(); len(got) != 1 || got[0] != "fixture/renamed-chat" {
			t.Errorf("favorites = %v", got)
		}
	})
	screen.Press("id:provider-model-more-renamed-chat")
	screen.Press("id:provider-model-remove-renamed-chat")
	screen.WaitFor("id:confirm-ok", 5*time.Second)
	screen.Press("id:confirm-ok")
	screen.WaitForGone("id:provider-model-renamed-chat", 5*time.Second)
	onNativeUI(t, screen, a, func() {
		if a.defaultModel.Provider != "" || len(a.favModels.GetUntracked()) != 0 || len(a.cfg.HiddenModels) != 0 {
			t.Error("delete left invalid default/favorite/hidden references")
		}
	})
}

func TestProviderManagerCancelAndInvalidNumbers(t *testing.T) {
	a, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, a, func() { a.openSettingsPane(); a.openSettingsSection("models") })
	screen.WaitFor("id:provider-manage-models-fixture", 5*time.Second)
	screen.Press("id:provider-manage-models-fixture")
	screen.WaitFor("id:provider-model-fixture-chat", 5*time.Second)
	screen.Press("id:provider-model-fixture-chat")
	screen.WaitFor("id:provider-model-context", 5*time.Second)
	screen.Clear("id:provider-model-context")
	screen.Type("id:provider-model-context", "oops")
	screen.Press("id:provider-model-save")
	screen.WaitFor("text:上下文与最大输出必须是非负整数；留空使用默认值。", 5*time.Second)
	screen.Press("id:provider-model-cancel")
	screen.WaitFor("id:confirm-ok", 5*time.Second)
	screen.Press("id:confirm-ok")
	screen.WaitFor("id:provider-model-fixture-chat", 5*time.Second)
	cfgs := readProviderConfigs()
	if len(cfgs) != 1 || cfgs[0].Models[0].ContextWindow != 32768 {
		t.Fatal("invalid or canceled draft changed saved context")
	}
	screen.Press("id:provider-tab-connection")
	screen.WaitFor("id:provider-base", 5*time.Second)
	screen.Type("id:provider-key", "draft-only-key")
	screen.Press("id:provider-cancel")
	screen.WaitFor("id:confirm-ok", 5*time.Second)
	screen.Press("id:confirm-ok")
	screen.WaitForGone("id:provider-dialog", 5*time.Second)
	raw, err := os.ReadFile(filepath.Join(piConfigDir(), "models.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "draft-only-key") {
		t.Fatal("canceled key leaked to disk")
	}
}
