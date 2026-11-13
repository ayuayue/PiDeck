package main

// Checks the ACP preset picker opens from the palette.

import (
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
