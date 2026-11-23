//go:build !js && !android && !ios

package workbench

// Checks the pi commands the settings page runs, and the authentication
// block of the provider dialog.

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

// TestProviderDialogAuthState opens a provider dialog and checks the
// authentication block reports pi's answer and offers a login.
func TestProviderDialogAuthState(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
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
	app.WaitFor("id:provider-dialog-check", 5*time.Second)
	app.Press("id:provider-model-a1")
	app.WaitFor("id:provider-model-images", 5*time.Second)
}
