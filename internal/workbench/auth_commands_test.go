//go:build !js && !android && !ios

package workbench

// Checks the pi commands the settings page runs and the separate provider
// configuration and credential-management flows.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestPiTerminalCommand checks a login runs pi itself, or cmd.exe for a
// batch shim.
func TestPiTerminalCommand(t *testing.T) {
	got := piTerminalCommand("/usr/local/bin/pi", "auth", "login", "acme")
	want := []string{"/usr/local/bin/pi", "auth", "login", "acme"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("command = %v", got)
	}
	batch := piTerminalCommand("/tools/pi.cmd", "auth", "login")
	if len(batch) < 3 || !strings.HasSuffix(batch[0], "cmd.exe") || !strings.Contains(batch[len(batch)-1], "auth") {
		t.Fatalf("batch command = %v", batch)
	}
}

// TestAuthCommandAgainstPi checks pi's own check and sign-out, with pi's
// configuration pointed at a test folder.
func TestAuthCommandAgainstPi(t *testing.T) {
	requirePi(t)
	dir := t.TempDir()
	t.Setenv("PI_CODING_AGENT_DIR", dir)
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	res, err := checkAuth("pi", "deepseek", false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "not_ready" || res.Provider != "deepseek" {
		t.Fatalf("check = %+v", res)
	}
	// Signing out of a provider with no stored credential is not an error.
	if err := logoutAuth("pi", "deepseek"); err != nil {
		t.Fatal(err)
	}
	if err := logoutAuth("pi", ""); err == nil {
		t.Fatal("a blank provider should be refused")
	}
}

// TestProviderDialogAuthState checks models stay editable in the provider
// dialog while credential actions live on the credentials page.
func TestProviderDialogAuthState(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	// This checks file-backed UI state; a background pi probe must not
	// outlive the screen and recreate auth.json during TempDir cleanup.
	t.Setenv("PATH", t.TempDir())
	home := t.TempDir()
	cfgDir := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PIDECK_V2_PI_CONFIG", cfgDir)
	t.Setenv("PI_CODING_AGENT_DIR", cfgDir)
	body := `{"providers":{"acme":{"api":"openai-completions","baseUrl":"https://acme.example/v1","models":[{"id":"a1"}]}}}`
	if err := os.WriteFile(filepath.Join(cfgDir, "models.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cfgDir, "auth.json"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	app := nsgotest.Start(t, Root, nsgotest.Size(1280, 860))
	app.Press("label:设置")
	app.WaitFor("id:settings-tab-models", 10*time.Second)
	app.Press("id:settings-tab-models")
	app.WaitFor("id:provider-configure-acme", 20*time.Second)
	app.Press("id:provider-configure-acme")
	app.WaitFor("id:provider-dialog", 5*time.Second)
	app.Find("id:provider-key")
	app.Press("id:provider-model-a1")
	app.WaitFor("id:provider-model-images", 5*time.Second)
	app.Press("id:provider-cancel")
	app.WaitForGone("id:provider-dialog", 5*time.Second)
	app.Press("id:settings-tab-credentials")
	app.WaitFor("text:还没有凭据", 5*time.Second)
	app.Find("id:auth-add")
	app.Find("id:auth-add-custom")
	if app.Exists("id:auth-check-acme") {
		t.Fatal("a models.json provider without a stored credential has a credential row")
	}
}

func TestAuthAddMethodsAndCustomKey(t *testing.T) {
	built, screen := startNativeSettingsApp(t)
	onNativeUI(t, screen, built, func() {
		built.authMethods.Set([]piAuthProvider{
			{ID: "key", Name: "Key Provider", APIKey: &piAPIKey{Login: true}},
			{ID: "oauth", Name: "OAuth Provider", OAuth: &piOAuthAuth{}},
		})
		built.authMethodsProvider.Set("key")
		built.openSettingsPane()
		built.openSettingsSection("credentials")
	})
	screen.Press("id:auth-add")
	screen.WaitFor("id:auth-methods-dialog", 5*time.Second)
	screen.Press("id:auth-methods-provider")
	screen.Press("role:option Key Provider · key")
	screen.WaitFor("id:auth-key-input", 5*time.Second)
	screen.Type("id:auth-key-input", "test-provider-key")
	screen.Press("id:auth-method-login-key")
	screen.WaitForGone("id:auth-methods-dialog", 5*time.Second)
	screen.WaitFor("id:auth-replace-key", 5*time.Second)
	onNativeUI(t, screen, built, func() {
		if got := built.authKeyProvider.GetUntracked(); got != "key" {
			t.Errorf("manual key provider = %q, want key", got)
		}
	})
	screen.Press("id:auth-add-oauth")
	screen.WaitFor("id:auth-methods-dialog", 5*time.Second)
	screen.Press("id:auth-methods-provider")
	screen.Press("role:option OAuth Provider · oauth")
	screen.WaitFor("id:auth-method-login-oauth", 5*time.Second)
	screen.Find("id:auth-method-login-oauth-no-browser")
	if screen.Exists("id:auth-method-login-key") {
		t.Fatal("an OAuth-only provider offers an API-key login")
	}
	screen.Press("id:auth-method-custom")
	screen.WaitFor("id:auth-key", 5*time.Second)
	onNativeUI(t, screen, built, func() {
		if got := built.authKeyProvider.GetUntracked(); got != "" {
			t.Errorf("custom key provider = %q, want empty", got)
		}
	})
	screen.Press("id:auth-key >> role:button 取消")
	screen.Press("id:auth-add-custom")
	screen.WaitFor("id:auth-key", 5*time.Second)
	screen.Find("id:auth-provider")
	screen.Find("id:auth-key-input")
}
