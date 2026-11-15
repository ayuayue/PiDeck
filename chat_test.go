package main

// Checks the built-in chat: a session that belongs to no project, in a
// folder the app makes under its data.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestBuiltinChat(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := editorWorkspace(t)
	t.Setenv("PIDECK_LITE_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.WaitFor("id:welcome-chat", 5*time.Second)
	app.Press("id:welcome-chat")
	app.WaitFor("id:composer", 10*time.Second)
	app.WaitFor("id:chat-transcript", 5*time.Second)
	dir := filepath.Join(home, "chat")
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		t.Fatalf("chat folder: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(home, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"chat": true`) {
		t.Fatalf("config has no chat workspace:\n%s", raw)
	}
	// The palette offers the same action, with its key.
	app.Press("id:rail-palette")
	app.WaitFor("text:新建对话（不绑定项目）", 5*time.Second)
	app.Key("escape")
}
