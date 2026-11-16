package main

// Checks that the settings page and the Git drawer's history scroll.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestSettingsPageScrolls(t *testing.T) {
	home := editorWorkspace(t)
	workspace := editorWorkspace(t)
	t.Setenv("PIDECK_LITE_HOME", home)
	raw, err := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: workspace, Name: "ScrollProject"}},
		Theme: "system", SidebarOpen: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	var built *app
	root := func(cx *core.Scope) core.Node { built = newApp(cx); return built.view() }
	screen := nsgotest.Start(t, root, nsgotest.Size(1280, 860))
	built.settings.Set(true)
	screen.Advance(200 * time.Millisecond)
	screen.Press("id:settings-tab-about")
	screen.Advance(200 * time.Millisecond)
	if screen.Find("id:check-updates") == nil {
		t.Fatal("the about page did not show its update button")
	}
	screen.Scroll("id:check-updates", 500)
}

func TestGitHistoryScrolls(t *testing.T) {
	workspace := editorWorkspace(t)
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = workspace
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q")
	run("config", "user.email", "a@b.c")
	run("config", "user.name", "A")
	for i := 0; i < 30; i++ {
		if err := os.WriteFile(filepath.Join(workspace, "file.txt"), []byte(fmt.Sprint(i)), 0o644); err != nil {
			t.Fatal(err)
		}
		run("add", ".")
		run("commit", "-q", "-m", fmt.Sprintf("commit %d", i+1))
	}
	home := editorWorkspace(t)
	t.Setenv("PIDECK_LITE_HOME", home)
	raw, err := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: workspace, Name: "GitProject", Expanded: true}},
		Theme: "system", SidebarOpen: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	root := func(cx *core.Scope) core.Node { return newApp(cx).view() }
	screen := nsgotest.Start(t, root, nsgotest.Size(1280, 860))
	screen.Press("id:git-toggle")
	screen.WaitUntil(30*time.Second, func() bool { return len(screen.Query("id:git-commit-row")) > 20 })
	screen.Scroll("id:git-log-search", 500)
}
