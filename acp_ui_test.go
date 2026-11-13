package main

// Checks the ACP preset picker and the mode picker on the badge.

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

// TestACPModePicker switches modes from the composer badge, against a fake
// agent that advertises two.
func TestACPModePicker(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := editorWorkspace(t)
	workspace := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
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
	app := openApp(t, workspace, 1280, 860)
	app.Press("id:rail-palette")
	app.WaitFor("text:新建 ACP 会话（选择预设）…", 5*time.Second)
	app.Press("text:新建 ACP 会话（选择预设）…")
	app.WaitFor("id:acp-preset-fake", 5*time.Second)
	app.Press("id:acp-preset-fake")
	app.WaitFor("id:composer", 10*time.Second)
	app.Type("id:composer", "hi")
	app.Press("role:button 发送")
	waitApp(app, "id:acp-mode-badge", 60*time.Second)
	app.Press("id:acp-mode-badge")
	app.WaitFor("id:acp-mode-code", 5*time.Second)
	app.Press("id:acp-mode-code")
	waitApp(app, `text:"Fake Agent · Code"`, 10*time.Second)
}
