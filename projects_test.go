package main

// Checks for the rail's project groups and pinning.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestProjectGroups checks pinned projects and named groups show as
// headings in the rail.
func TestProjectGroups(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	base := t.TempDir()
	mk := func(name string) string {
		dir := filepath.Join(base, name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	alpha, beta, gamma := mk("alpha"), mk("beta"), mk("gamma")
	cfg := config{Version: 1, Theme: "system", SidebarOpen: true, ProjectSort: "title",
		Workspaces: []workspaceCfg{
			{Path: alpha, Expanded: true, Pinned: true, Added: time.Now()},
			{Path: beta, Expanded: true, Group: "工作", Added: time.Now()},
			{Path: gamma, Expanded: true, Group: "工作", Added: time.Now()},
		}}
	raw, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_LITE_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:置顶")) > 0 })
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:工作")) > 0 })
	for _, name := range []string{"alpha", "beta", "gamma"} {
		app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:"+name)) > 0 })
	}
}
