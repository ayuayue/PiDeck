package main

// Checks that the terminal panel starts a real shell and shows its grid.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	sgt "github.com/nsgo-dev/nsgo/base/terminal"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestTerminalPanel opens the panel and waits for the terminal's view.
func TestTerminalPanel(t *testing.T) {
	if err := sgt.Load(); err != nil {
		t.Skipf("terminal unavailable: %v", err)
	}
	// The shell runs in the project, not the test's data directory: a
	// real shell holds its working directory open, which would keep the
	// temporary folder from being removed on Windows.
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	raw, err := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: dir, Expanded: true}},
		Theme: "system", SidebarOpen: true, ScanPi: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(closeAllTerminals)
	app := nsgotest.Start(t, Root, nsgotest.Size(1320, 860))
	app.Press("id:terminal-toggle")
	waitApp(app, "id:terminal-view", 30*time.Second)
	app.Advance(500 * time.Millisecond)
	// A second tab, then hiding the panel keeps both running.
	app.Press("id:terminal-new")
	app.Advance(300 * time.Millisecond)
	if got := len(app.Query("id:terminal-tab")); got != 2 {
		t.Fatalf("tabs = %d, want 2", got)
	}
	app.Press("id:terminal-hide")
	app.Advance(200 * time.Millisecond)
	if got := len(app.Query("id:terminal-view")); got != 0 {
		t.Fatalf("terminal view still shows after hiding")
	}
	app.Press("id:terminal-toggle")
	waitApp(app, "id:terminal-view", 30*time.Second)
	if got := len(app.Query("id:terminal-tab")); got != 2 {
		t.Fatalf("tabs after reopening = %d, want 2", got)
	}
	shot(app, "41-terminal")
}
