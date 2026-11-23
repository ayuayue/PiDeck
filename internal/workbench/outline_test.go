//go:build !js && !android && !ios

package workbench

// Checks the session outline: one row per prompt, jumping to it.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestSessionOutline(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := editorWorkspace(t)
	workspace := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	var turns []turn
	for i := 0; i < 12; i++ {
		turns = append(turns, turn{ID: fmt.Sprintf("t%d", i), Prompt: fmt.Sprintf("第 %d 个问题，写长一点让每一轮占些高度。", i+1),
			Status: chat.Completed, Start: base.Add(time.Duration(i) * time.Minute), End: base.Add(time.Duration(i)*time.Minute + time.Second),
			Final: fmt.Sprintf("第 %d 个回答，也写长一点。", i+1)})
	}
	arch := acpArchive{ID: "acp-outline", Preset: "fake", Title: "大纲会话", Cwd: workspace, Updated: base, Turns: turns}
	raw, err := json.Marshal(arch)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, "acp-sessions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "acp-outline.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := json.Marshal(config{Version: 2,
		Workspaces:  []workspaceCfg{{Path: workspace, Name: "大纲项目", Expanded: true}},
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
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("role:button 大纲会话")) > 0 })
	app.Press("role:button 大纲会话 >> nth=0")
	app.WaitFor("text:第 12 个问题，写长一点让每一轮占些高度。", 10*time.Second)

	app.Key("mod+shift+o")
	app.WaitFor("id:outline-dialog", 5*time.Second)
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("id:outline-row")) == 12 })
	app.Press("id:outline-row >> nth=0")
	app.WaitForGone("id:outline-dialog", 5*time.Second)
	app.WaitFor("label:跳到最新消息", 5*time.Second)
}
