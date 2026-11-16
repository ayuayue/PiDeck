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

// TestTurnAtFraction checks which turn the ruler's tooltip names: the one
// standing in the middle of the transcript after the jump.
func TestTurnAtFraction(t *testing.T) {
	tops := map[int]float64{0: 0, 1: 500, 2: 1200}
	cases := []struct {
		fraction, content, frame float64
		want                     int
	}{
		{0, 2000, 500, 0},   // middle at 250, inside the first turn
		{0.5, 2000, 500, 1}, // middle at 1000, inside the second
		{1, 2000, 500, 2},   // middle at 1750, inside the third
	}
	for _, c := range cases {
		if got := turnAtFraction(tops, 3, c.fraction, c.content, c.frame); got != c.want {
			t.Errorf("fraction %v put turn %d in the middle, want %d", c.fraction, got, c.want)
		}
	}
	// Before a turn is measured, or when the transcript fits, the tick
	// falls back to turn order.
	if got := turnAtFraction(nil, 5, 0.5, 2000, 500); got != 2 {
		t.Errorf("an unmeasured transcript picked turn %d, want 2", got)
	}
	if got := turnAtFraction(nil, 5, 1, 200, 500); got != 4 {
		t.Errorf("a transcript that fits picked turn %d, want 4", got)
	}
	if got := turnAtFraction(nil, 0, 0.5, 0, 0); got != -1 {
		t.Errorf("no turns picked turn %d", got)
	}
}
