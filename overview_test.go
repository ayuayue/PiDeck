package main

// Checks the session overview copies its id.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestOverviewCopyID(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	app := startApp(t, workspaceWith(t), 1320, 860)
	waitApp(app, "id:pi-ready", 90*time.Second)
	raw, err := os.ReadFile(filepath.Join(home, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cfg config
	if json.Unmarshal(raw, &cfg) != nil || len(cfg.Tabs) == 0 {
		t.Fatalf("config = %s", raw)
	}
	id := cfg.Tabs[0]
	app.Key("mod+j")
	app.WaitFor("id:drawer-tab-overview", 5*time.Second)
	app.Press("id:drawer-tab-overview")
	app.WaitFor("id:overview-copy-id", 5*time.Second)
	app.Press("id:overview-copy-id")
	if app.Clipboard != id {
		t.Fatalf("clipboard = %q, want %q", app.Clipboard, id)
	}
}
