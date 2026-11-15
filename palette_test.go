package main

// Checks the palette lists projects and sessions, and opens them.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestPaletteSessions(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := editorWorkspace(t)
	workspace := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, "sessions", encodeCwd(workspace))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"type":"session","version":3,"id":"pal-1","timestamp":"2026-06-01T10:00:00Z","cwd":%q}
{"type":"message","id":"u-1","parentId":null,"timestamp":"2026-06-01T10:00:01Z","message":{"role":"user","content":[{"type":"text","text":"看看这个项目"}]}}
`, workspace)
	if err := os.WriteFile(filepath.Join(dir, "pal-1.jsonl"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := json.Marshal(config{Version: 2,
		Workspaces: []workspaceCfg{{Path: workspace, Name: "调色板项目", Expanded: true}},
		Theme:      "system", SidebarOpen: true, ScanPi: false,
		Titles: map[string]string{"pal-1": "调色板会话"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), cfg, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_LITE_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1280, 860))
	app.Press("id:rail-palette")
	app.Type("label:命令", "调色板会话")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("role:option 调色板会话")) > 0 })
	app.Press("role:option 调色板会话")
	app.WaitFor("id:composer", 20*time.Second)

	// The project itself is a row, and opens its newest session.
	app.Press("id:rail-palette")
	app.Type("label:命令", "调色板项目")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("role:option 调色板项目")) > 0 })
	app.Press("role:option 调色板项目")
	app.WaitFor("id:composer", 20*time.Second)
}

// TestRecentCommands puts a used command at the top of the palette.
func TestRecentCommands(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Press("id:rail-palette")
	app.WaitFor("id:palette", 10*time.Second)
	app.Type("label:命令", "切换深浅色")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("role:option 切换深浅色")) > 0 })
	app.Press("role:option 切换深浅色")
	app.Press("id:rail-palette")
	app.WaitFor("id:palette", 10*time.Second)
	app.WaitFor("text:最近", 5*time.Second)
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("role:option 切换深浅色")) > 0 })
	raw, err := os.ReadFile(filepath.Join(home, "config.json"))
	if err != nil || !strings.Contains(string(raw), "appearance-cycle") {
		t.Fatalf("config = %s, %v", raw, err)
	}
}
