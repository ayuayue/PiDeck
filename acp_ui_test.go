package main

// Checks the ACP preset picker, the mode picker on the badge and the
// per-turn change summary.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/nsgotest"
)

// TestACPPicker opens the picker without starting an agent.
func TestACPPicker(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := editorWorkspace(t)
	workspace := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_LITE_HOME", home)
	app := openApp(t, workspace, 1280, 860)
	app.Press("id:rail-palette")
	app.WaitFor("text:新建 ACP 会话（选择预设）…", 5*time.Second)
	app.Press("text:新建 ACP 会话（选择预设）…")
	app.WaitFor("id:acp-dialog", 5*time.Second)
	app.WaitFor("id:acp-preset-claude", 5*time.Second)
	app.Key("escape")
	app.WaitForGone("id:acp-dialog", 5*time.Second)
}

// fakeACPApp starts an app over a project with one fake ACP preset and
// two files, the fake agent answering in UI mode.
func fakeACPApp(t *testing.T) *nsgotest.App {
	t.Helper()
	home := editorWorkspace(t)
	workspace := editorWorkspace(t)
	for name, text := range map[string]string{"note.txt": "hello", "changed.txt": "EDITED-CONTENT"} {
		if err := os.WriteFile(filepath.Join(workspace, name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	dir := filepath.Join(home, "acp")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	preset, err := json.Marshal(map[string]any{"presets": []map[string]any{{
		"id": "fake", "name": "Fake Agent", "command": os.Args[0],
		"args": []string{"-test.run=TestFakeACPAgent"},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "fake.json"), preset, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_LITE_HOME", home)
	t.Setenv("PIDECK_FAKE_ACP", "1")
	t.Setenv("PIDECK_FAKE_ACP_UI", "1")
	t.Cleanup(closeAllACP)
	return openApp(t, workspace, 1280, 860)
}

// newFakeACPSession picks the fake preset and sends one prompt.
func newFakeACPSession(t *testing.T, app *nsgotest.App) {
	t.Helper()
	app.Press("id:rail-palette")
	app.WaitFor("text:新建 ACP 会话（选择预设）…", 5*time.Second)
	app.Press("text:新建 ACP 会话（选择预设）…")
	app.WaitFor("id:acp-preset-fake", 5*time.Second)
	app.Press("id:acp-preset-fake")
	app.WaitFor("id:composer", 10*time.Second)
	app.Type("id:composer", "hi")
	app.Press("role:button 发送")
}

// TestACPModePicker switches modes from the composer badge, against a fake
// agent that advertises two.
func TestACPModePicker(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	app := fakeACPApp(t)
	newFakeACPSession(t, app)
	waitApp(app, "id:acp-mode-badge", 60*time.Second)
	// The badge and its menu can still be settling under load; try again.
	for i := 0; i < 4; i++ {
		app.Press("id:acp-mode-badge")
		if waitQuiet(app, "id:acp-mode-code", 2*time.Second) {
			app.Press("id:acp-mode-code")
		}
		if waitQuiet(app, `text:"Fake Agent · Code"`, 2*time.Second) {
			break
		}
	}
	waitApp(app, `text:"Fake Agent · Code"`, 10*time.Second)
}

// TestACPChangeSummary folds the turn's edited files into a row and opens
// one from it in the editor.
func TestACPChangeSummary(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	app := fakeACPApp(t)
	newFakeACPSession(t, app)
	waitApp(app, "id:turn-changes", 60*time.Second)
	app.Press("id:turn-changes")
	app.WaitFor("id:turn-change-0", 5*time.Second)
	app.Press("id:turn-change-0")
	app.WaitFor("id:editor-close", 10*time.Second)
	waitApp(app, "text:EDITED-CONTENT", 10*time.Second)
}
