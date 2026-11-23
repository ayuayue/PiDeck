//go:build !js && !android && !ios

package workbench

// Checks that the window, the panels and the pages that remember where the
// user was do write it to the config, and read it back on the next start.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"example.com/pideck-v2/internal/crashlog"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// readConfig reads a folder's config.json.
func readConfig(t *testing.T, dir string) config {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	var c config
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

// TestPanelAndPageStatePersist checks the settings page, the drawer tab and
// the rail's width survive a restart.
func TestPanelAndPageStatePersist(t *testing.T) {
	home := t.TempDir()
	workspace := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	raw, err := json.Marshal(config{Version: 1, Theme: "system", SidebarOpen: true, DrawerOpen: true,
		Workspaces: []workspaceCfg{{Path: workspace, Expanded: true, Added: time.Now()}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	var built *app
	root := func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}
	first := nsgotest.Start(t, root, nsgotest.Size(1280, 860))
	first.Settle()
	if built == nil {
		t.Fatal("the app was not built")
	}

	built.openSettingsSection("models")
	built.setDrawerTab("files")
	built.setRailWidth(318)
	built.setDrawerWidth(344)
	first.Advance(500 * time.Millisecond)
	first.Settle()

	saved := readConfig(t, home)
	if saved.SettingsTab != "models" {
		t.Fatalf("settings tab saved as %q, want models", saved.SettingsTab)
	}
	if saved.DrawerTab != "files" {
		t.Fatalf("drawer tab saved as %q, want files", saved.DrawerTab)
	}
	if saved.RailWidth != 318 || saved.DrawerWidth != 344 {
		t.Fatalf("widths saved as %v/%v, want 318/344", saved.RailWidth, saved.DrawerWidth)
	}

	// The next start opens on the same page and tab.
	again, err := newStore(home)
	if err != nil {
		t.Fatal(err)
	}
	cfg := again.config()
	if cfg.SettingsTab != "models" || cfg.DrawerTab != "files" || cfg.RailWidth != 318 {
		t.Fatalf("the config does not read back: %+v", cfg)
	}

	var rebuilt *app
	root2 := func(cx *core.Scope) core.Node {
		rebuilt = newApp(cx)
		return rebuilt.view()
	}
	screen := nsgotest.Start(t, root2, nsgotest.Size(1280, 860))
	screen.Settle()
	if rebuilt == nil {
		t.Fatal("the second app was not built")
	}
	if got := rebuilt.settingsTab.GetUntracked(); got != "models" {
		t.Fatalf("the restored settings tab = %q, want models", got)
	}
	if got := rebuilt.drawerTab.GetUntracked(); got != "files" {
		t.Fatalf("the restored drawer tab = %q, want files", got)
	}
	if got := rebuilt.railWidth.GetUntracked(); got != 318 {
		t.Fatalf("the restored rail width = %v", got)
	}
	// Opening the page runs the restored section's loader instead of
	// falling back to the first one.
	rebuilt.openSettingsPane()
	screen.Settle()
	if got := rebuilt.settingsTab.GetUntracked(); got != "models" {
		t.Fatalf("opening settings switched to %q", got)
	}
}

// TestImportTabPersists checks the import dialog remembers the source tab.
func TestImportTabPersists(t *testing.T) {
	home := t.TempDir()
	store := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PIDECK_V2_IMPORT_CLAUDE_DIR", store)
	dir := filepath.Join(store, "--x--")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"type":"user","sessionId":"s1","cwd":"C:/work/x","uuid":"u1","timestamp":"2026-06-01T10:00:00Z","message":{"role":"user","content":"导入用"}}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, "s1.jsonl"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	var built *app
	root := func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}
	app := nsgotest.Start(t, root, nsgotest.Size(1280, 860))
	app.Settle()
	if built == nil {
		t.Fatal("the app was not built")
	}
	built.openImportDialog()
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:import-tab-claude")) == 1 })
	app.Press("id:import-tab-claude")
	app.Settle()
	if saved := readConfig(t, home); saved.ImportSource != "claude" {
		t.Fatalf("import tab saved as %q, want claude", saved.ImportSource)
	}
	if got := built.impOnly.GetUntracked(); got != "claude" {
		t.Fatalf("the dialog's tab = %q", got)
	}
}

// TestWindowFrameIsRemembered checks the saved frame is what a window opens
// with, and that a size too small to be a window is ignored.
func TestWindowFrameIsRemembered(t *testing.T) {
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	// A test binary shares one record of the data folder; a start reads it
	// before any app exists, so clear it here.
	crashlog.SetDataDir("")
	cfg := config{Version: 1, Window: windowCfg{X: 120, Y: 80, W: 1440, H: 900, Maximized: true}}
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	frame, ok := InitialWindowFrame()
	if !ok {
		t.Fatal("the saved frame was not read")
	}
	if frame.X != 120 || frame.Y != 80 || frame.Width != 1440 || frame.Height != 900 || !frame.Move {
		t.Fatalf("frame = %+v", frame)
	}

	if err := os.WriteFile(filepath.Join(home, "config.json"),
		[]byte(`{"version":1,"window":{"w":300,"h":200}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := InitialWindowFrame(); ok {
		t.Fatal("a 300x200 frame was taken as a window")
	}
}
