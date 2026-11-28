//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestAuthSettingsUserJourney(t *testing.T) {
	pi, _ := authBridgeFixture(t)
	runner, err := piRegistryRunner()
	if err != nil {
		t.Fatal(err)
	}
	a, screen := startNativeSettingsApp(t)
	// This journey explicitly runs the fixture SDK; the settings fixture hides CLIs.
	t.Setenv("PATH", filepath.Dir(runner))
	onNativeUI(t, screen, a, func() {
		a.cfg.PiExecutable = pi
		a.authMethods.Set([]piAuthProvider{
			{ID: "anthropic", Name: "Anthropic", APIKey: &piAPIKey{Login: true}},
			{ID: "fixture", Name: "Fixture OAuth", OAuth: &piOAuthAuth{}},
			{ID: "ambient", Name: "Cloud credentials", APIKey: &piAPIKey{Name: "Cloud profile"}},
		})
		a.openSettingsPane()
		a.openSettingsSection("credentials")
	})
	screen.WaitFor("id:auth-add", 5*time.Second)
	screen.Press("id:auth-add")
	screen.Press("id:auth-methods-provider")
	screen.Press("role:option Cloud credentials · ambient")
	if screen.Exists("id:auth-method-login-key") {
		t.Fatal("ambient credentials offered an ineffective key save")
	}
	screen.Press("id:auth-methods-provider")
	screen.Press("role:option Anthropic · anthropic")
	screen.Press("id:auth-method-login-key")
	screen.WaitFor("id:auth-key-error", 5*time.Second)
	screen.Type("id:auth-key-input", "fixture-first-key")
	screen.Press("id:auth-method-login-key")
	screen.WaitForGone("id:auth-methods-dialog", 5*time.Second)
	screen.WaitFor("id:auth-replace-anthropic", 5*time.Second)
	screen.Press("id:auth-replace-anthropic")
	screen.Type("id:auth-key-input", "fixture-replacement-key")
	screen.Press("id:auth-key-save")
	screen.WaitForGone("id:auth-key", 5*time.Second)

	screen.Press("id:auth-add-custom")
	screen.Type("id:auth-provider", "custom-api")
	screen.Type("id:auth-key-input", "fixture-custom-key")
	screen.Press("id:auth-key-save")
	screen.WaitForGone("id:auth-key", 5*time.Second)
	screen.WaitFor("id:auth-delete-custom-api", 5*time.Second)
	screen.Press("id:auth-delete-custom-api")
	screen.Press("id:confirm-cancel")
	screen.WaitForGone("id:confirm", 5*time.Second)
	screen.Find("id:auth-delete-custom-api")
	screen.Press("id:auth-delete-custom-api")
	screen.Press("id:confirm-ok")
	screen.WaitForGone("id:auth-delete-custom-api", 5*time.Second)
	raw, err := os.ReadFile(authPath())
	if err != nil {
		t.Fatal(err)
	}
	var saved map[string]map[string]string
	if json.Unmarshal(raw, &saved) != nil || saved["anthropic"]["key"] != "fixture-replacement-key" {
		t.Fatal("key replacement/delete lost another provider")
	}

	// One-click login starts immediately; cancellation releases the page.
	screen.Press("id:auth-oauth-fixture")
	screen.WaitFor("id:auth-flow-option-plan", 5*time.Second)
	screen.Press("id:auth-flow-close")
	screen.WaitForGone("id:auth-flow-dialog", 5*time.Second)
	screen.Press("id:auth-add-oauth")
	screen.Press("id:auth-methods-provider")
	screen.Press("role:option Fixture OAuth · fixture")
	screen.Press("id:auth-method-login-oauth-no-browser")
	screen.WaitFor("id:auth-flow-option-plan", 5*time.Second)
	screen.Press("id:auth-flow-option-plan")
	screen.WaitFor("label:Fixture tenant", 5*time.Second)
	screen.Type("id:auth-flow-answer", "tenant")
	screen.Press("id:auth-flow-submit")
	screen.WaitFor("label:Optional fixture value", 5*time.Second)
	screen.Press("id:auth-flow-submit")
	screen.WaitFor("label:Fixture secret", 5*time.Second)
	screen.Type("id:auth-flow-answer", "fixture-key")
	screen.Press("id:auth-flow-submit")
	screen.WaitFor("text:登录成功，凭据已保存到 auth.json。", 5*time.Second)
	screen.Press("id:auth-flow-close")
	screen.WaitForGone("id:auth-flow-dialog", 5*time.Second)
	screen.WaitFor("id:auth-relogin-fixture", 5*time.Second)
	screen.Find("text:已登录")
	if nsgotest.Target() != "" {
		screen.Screenshot("auth-account-signed-in")
	}

	screen.Focus("id:auth-proxy-agent")
	screen.Type("id:auth-proxy-agent", "invalid-proxy")
	screen.Press("id:auth-proxy-save")
	screen.WaitFor("id:auth-proxy-error", 5*time.Second)
	screen.Clear("id:auth-proxy-agent")
	screen.Type("id:auth-proxy-agent", "http://127.0.0.1:7890")
	screen.Press("id:auth-proxy-save")
	screen.WaitForGone("id:auth-proxy-error", 5*time.Second)
	onNativeUI(t, screen, a, func() {
		if a.cfg.ProxyAgent != "http://127.0.0.1:7890" {
			t.Error("proxy did not use the existing Agent setting")
		}
	})
}

func TestAuthProviderSelectionDoesNotActivateActions(t *testing.T) {
	pi, _ := authBridgeFixture(t)
	a, screen := startNativeSettingsApp(t)
	screen.Resize(900, 720)
	onNativeUI(t, screen, a, func() {
		a.cfg.PiExecutable = pi
		a.authMethods.Set([]piAuthProvider{
			{ID: "alibaba", Name: "Alibaba", APIKey: &piAPIKey{Login: true}},
			{ID: "amazon", Name: "Amazon", APIKey: &piAPIKey{Login: true}},
			{ID: "anthropic", Name: "Anthropic", APIKey: &piAPIKey{Login: true}},
			{ID: "fixture", Name: "Fixture OAuth", OAuth: &piOAuthAuth{}},
		})
		a.openSettingsPane()
		a.openSettingsSection("credentials")
	})
	screen.WaitFor("id:auth-add", 5*time.Second)
	screen.Press("id:auth-add")
	screen.Press("id:auth-methods-provider")
	screen.Press("role:option Anthropic · anthropic")
	if !screen.Exists("id:auth-methods-dialog") || screen.Exists("id:auth-flow-dialog") || screen.Exists("id:auth-key-error") {
		t.Fatal("choosing a provider activated an action below the closed popup")
	}
	screen.Find("id:auth-key-input")
	dialog := screen.Find("id:auth-methods-dialog").Bounds()
	picker := screen.Find("id:auth-methods-provider").Bounds()
	if dialog.Origin.X < 0 || dialog.Origin.Y < 0 || dialog.Size.Width > 560 || dialog.Origin.X+dialog.Size.Width > 900 || dialog.Origin.Y+dialog.Size.Height > 720 {
		t.Fatalf("provider dialog does not fit the narrow window: %+v", dialog)
	}
	if picker.Size.Width < dialog.Size.Width-50 {
		t.Fatalf("provider picker wastes form width: dialog=%+v picker=%+v", dialog, picker)
	}
	if nsgotest.Target() != "" {
		screen.Screenshot("auth-provider-key-form")
	}
	screen.Focus("id:auth-method-login-key")
	screen.Key("enter")
	screen.WaitFor("id:auth-key-error", 5*time.Second)
	screen.Type("id:auth-key-input", "fixture-selected-key")
	screen.Press("id:auth-method-login-key")
	screen.WaitForGone("id:auth-methods-dialog", 5*time.Second)
	screen.WaitFor("id:auth-replace-anthropic", 5*time.Second)
}

func TestAuthProgressKeepsCodeAndIgnoresOldCancellation(t *testing.T) {
	a, screen := startNativeSettingsApp(t)
	answers := make(chan authFlowCommand, 1)
	onNativeUI(t, screen, a, func() {
		a.authUI.Answers = answers
		a.authUI.Flow.Set(authFlowView{Open: true, Phase: "running", Provider: "fixture", NoBrowser: true})
		a.receiveAuthFlow(authFlowMessage{Type: "prompt", ID: "current", Prompt: &authPrompt{Kind: "manual_code", Message: "Fixture authorization code"}})
	})
	screen.WaitFor("id:auth-flow-answer", 5*time.Second)
	screen.Type("id:auth-flow-answer", "partial-")
	onNativeUI(t, screen, a, func() {
		a.receiveAuthFlow(authFlowMessage{Type: "event", Event: authFlowEvent{Type: "progress", Message: "Still waiting"}})
		a.receiveAuthFlow(authFlowMessage{Type: "prompt-cancelled", ID: "old"})
	})
	if input := screen.Find("id:auth-flow-answer"); !input.Focused || input.Text != "partial-" {
		t.Fatal("progress or stale callback replaced a partially typed code")
	}
	screen.Type("id:auth-flow-answer", "code")
	screen.Press("id:auth-flow-submit")
	select {
	case command := <-answers:
		if command.ID != "current" || command.Value != "partial-code" {
			t.Fatal("wrong prompt answer")
		}
	default:
		t.Fatal("prompt answer was not sent")
	}
	screen.Press("id:auth-flow-close")
	screen.WaitForGone("id:auth-flow-dialog", 5*time.Second)
}
