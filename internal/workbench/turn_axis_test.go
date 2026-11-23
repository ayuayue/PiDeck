//go:build !js && !android && !ios

package workbench

// Checks the transcript's right-edge ruler: how it samples a long
// conversation, and a click jumping back to the start.

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// TestPlanAxisTicks gives every turn a mark while they fit, and an even
// sample that keeps both ends when they do not.
func TestPlanAxisTicks(t *testing.T) {
	if got := planAxisTicks(0, 370); got != nil {
		t.Fatalf("no turns planned %v marks", got)
	}
	if got := planAxisTicks(10, 0); got != nil {
		t.Fatalf("no band planned %v marks", got)
	}
	all := planAxisTicks(5, 370)
	if len(all) != 5 {
		t.Fatalf("five turns fit %d marks, want 5", len(all))
	}
	for i, turn := range all {
		if turn != i {
			t.Fatalf("mark %d stands for turn %d", i, turn)
		}
	}

	// A 100 point band holds 26 marks; 200 turns need sampling.
	crowded := planAxisTicks(200, 100)
	if len(crowded) != 26 {
		t.Fatalf("200 turns made %d marks, want 26", len(crowded))
	}
	if crowded[0] != 0 || crowded[len(crowded)-1] != 199 {
		t.Fatalf("the sample dropped an end: %d … %d", crowded[0], crowded[len(crowded)-1])
	}
	for i := 1; i < len(crowded); i++ {
		if crowded[i] <= crowded[i-1] {
			t.Fatalf("marks are not ascending: %v", crowded)
		}
	}
}

// openLongSession opens a stored ACP transcript with many turns and returns
// the app with its ruler showing.
func openLongSession(t *testing.T) *nsgotest.App {
	t.Helper()
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
	t.Setenv("PIDECK_V2_HOME", home)
	app := nsgotest.Start(t, Root, nsgotest.Size(1280, 860))
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("role:button 长会话")) > 0 })
	app.Press("role:button 长会话 >> nth=0")
	app.WaitFor("id:composer", 20*time.Second)
	app.WaitFor("id:axis-tick-0", 10*time.Second)
	return app
}

// TestTurnAxis checks the ruler appears and jumps to the start with a tick.
func TestTurnAxis(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	app := openLongSession(t)
	app.Press("id:axis-tick-0")
	app.WaitFor("label:跳到最新消息", 5*time.Second)
}

// TestAxisTicksGrowOnHover keeps the ruler's marks short at rest and grows
// only the one under the pointer, so the scale reads as a track instead of a
// picket fence.
func TestAxisTicksGrowOnHover(t *testing.T) {
	if testing.Short() {
		t.Skip("opens a window")
	}
	app := openLongSession(t)
	// The bar's frame is what the layout transition animates, so read it
	// after the clock has had time to land. A real window rounds lengths to
	// its device pixels, hence the tolerance.
	width := func(id string) float64 {
		t.Helper()
		app.Advance(300 * time.Millisecond)
		return float64(app.Find(id).Frame.Size.Width)
	}
	near := func(got float64, want int) bool { return math.Abs(got-float64(want)) < 1 }

	if got := width("id:axis-tick-0"); !near(got, axisTickNarrow) {
		t.Fatalf("tick at rest = %v, want %v", got, axisTickNarrow)
	}
	shot(app, "57-axis-ticks-rest")

	app.Hover("id:axis-tick-3")
	if got := width("id:axis-tick-3"); !near(got, axisTickWidth) {
		t.Fatalf("tick under the pointer = %v, want %v", got, axisTickWidth)
	}
	if got := width("id:axis-tick-0"); !near(got, axisTickNarrow) {
		t.Fatalf("a tick away from the pointer = %v, want %v", got, axisTickNarrow)
	}
	shot(app, "58-axis-ticks-hover")

	// Sliding down the scale shortens the mark left behind and grows the one
	// the pointer reached.
	app.Hover("id:axis-tick-8")
	if got := width("id:axis-tick-3"); !near(got, axisTickNarrow) {
		t.Fatalf("the mark left behind = %v, want %v", got, axisTickNarrow)
	}
	if got := width("id:axis-tick-8"); !near(got, axisTickWidth) {
		t.Fatalf("the mark reached = %v, want %v", got, axisTickWidth)
	}

}
