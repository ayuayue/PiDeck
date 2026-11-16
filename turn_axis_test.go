package main

// Checks the transcript's right-edge ruler: how it samples a long
// conversation, and a click jumping back to the start.

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

func TestAxisTicks(t *testing.T) {
	if got := axisTicks(0); got != 0 {
		t.Fatalf("no band made %d ticks", got)
	}
	if got := axisTicks(10); got != axisLeast {
		t.Fatalf("a short band made %d ticks, want %d", got, axisLeast)
	}
	if got := axisTicks(280); got != 41 {
		t.Fatalf("a 280 point band made %d ticks, want 41", got)
	}
	if got := axisTicks(100000); got != axisMost {
		t.Fatalf("a huge band made %d ticks, want %d", got, axisMost)
	}
	fs := axisFractions(5)
	if len(fs) != 5 || fs[0] != 0 || fs[2] != 0.5 || fs[4] != 1 {
		t.Fatalf("five ticks stand at %v", fs)
	}
	for i := 1; i < len(fs); i++ {
		if fs[i] <= fs[i-1] {
			t.Fatalf("ticks are not ascending: %v", fs)
		}
	}
}

// TestTurnAxis opens a stored ACP transcript with many turns, checks the
// ruler appears, and jumps to its start with a tick.
func TestTurnAxis(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := editorWorkspace(t)
	workspace := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	var turns []turn
	for i := 0; i < 20; i++ {
		turns = append(turns, turn{ID: fmt.Sprintf("t%d", i), Prompt: fmt.Sprintf("第 %d 个问题，带一点长度让这一轮占些地方。", i+1),
			Status: chat.Completed, Start: base.Add(time.Duration(i) * time.Minute), End: base.Add(time.Duration(i)*time.Minute + time.Second),
			Final: fmt.Sprintf("第 %d 个回答。", i+1)})
	}
	arch := acpArchive{ID: "acp-long", Preset: "fake", Title: "长会话", Cwd: workspace, Updated: base, Turns: turns}
	raw, err := json.Marshal(arch)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, "acp-sessions")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "acp-long.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := json.Marshal(config{Version: 2,
		Workspaces:  []workspaceCfg{{Path: workspace, Name: "长会话项目", Expanded: true}},
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
	t.Setenv("PIDECK_LITE_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1280, 860))
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("role:button 长会话")) > 0 })
	app.Press("role:button 长会话 >> nth=0")
	app.WaitFor("id:composer", 20*time.Second)
	app.WaitFor("id:axis-tick-0", 10*time.Second)
	app.Press("id:axis-tick-0")
	app.WaitFor("label:跳到最新消息", 5*time.Second)
}
