//go:build !js && !android && !ios

package workbench

// Checks renaming a project from its menu.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestProjectRename(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	workspace := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := json.Marshal(config{Version: 2,
		Workspaces:  []workspaceCfg{{Path: workspace, Name: "旧项目名", Expanded: true}},
		Theme:       "system",
		SidebarOpen: true,
		ScanPi:      false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), cfg, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_V2_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1280, 860))
	app.WaitFor("role:button 旧项目名", 10*time.Second)
	for i := 0; i < 4; i++ {
		app.RightClick("role:button 旧项目名")
		if waitQuiet(app, "text:重命名项目…", 2*time.Second) {
			break
		}
	}
	app.Press("text:重命名项目…")
	app.WaitFor("id:ws-rename", 5*time.Second)
	app.Clear("id:ws-rename-input")
	app.Type("id:ws-rename-input", "新项目名")
	app.Press("id:ws-rename-save")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("role:button 新项目名")) > 0 })
	raw, err := os.ReadFile(filepath.Join(home, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	var saved config
	if json.Unmarshal(raw, &saved) != nil || len(saved.Workspaces) != 1 || saved.Workspaces[0].Name != "新项目名" {
		t.Fatalf("config = %s", raw)
	}
}
