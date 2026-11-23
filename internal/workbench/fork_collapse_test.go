//go:build !js && !android && !ios

package workbench

// Checks folding a branch of the fork tree.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestForkTreeCollapse(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
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
	write := func(id, prompt string) {
		body := fmt.Sprintf(`{"type":"session","version":3,"id":"%s","timestamp":"2026-06-01T10:00:00Z","cwd":%q}
{"type":"message","id":"u-%s","timestamp":"2026-06-01T10:00:01Z","message":{"role":"user","content":%q}}
`, id, workspace, id, prompt)
		if err := os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("parent-1", "父提问")
	write("child-1", "子提问")
	write("grandchild-1", "孙提问")
	cfg, err := json.Marshal(config{Version: 2,
		Workspaces:  []workspaceCfg{{Path: workspace, Name: "分叉项目", Expanded: true}},
		Theme:       "system",
		SidebarOpen: true,
		ScanPi:      false,
		Titles:      map[string]string{"parent-1": "父会话", "child-1": "子会话", "grandchild-1": "孙会话"},
		ForkParents: map[string]string{"child-1": "parent-1", "grandchild-1": "child-1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), cfg, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_V2_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1280, 860))
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("role:button 子会话")) > 0 })
	app.Press("role:button 子会话 >> nth=0")
	app.WaitFor("id:composer", 10*time.Second)
	app.Press("id:rail-palette")
	app.Type("label:命令", "分叉树")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("role:option")) > 0 })
	app.Press("role:option >> nth=0")
	app.WaitFor("id:fork-tree", 5*time.Second)
	app.WaitFor("id:fork-node-grandchild-1", 5*time.Second)

	app.Press("id:fork-toggle-child-1")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("id:fork-node-grandchild-1")) == 0 })
	if len(app.Query("id:fork-node-child-1")) == 0 {
		t.Fatal("folding a branch hid the branch itself")
	}
	app.Press("id:fork-toggle-child-1")
	app.WaitFor("id:fork-node-grandchild-1", 5*time.Second)
}
