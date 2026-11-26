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

	"github.com/nsgo-dev/nsgo/core"
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

	// A 100 point band holds twelve complete 8 point hit slots.
	crowded := planAxisTicks(200, 100)
	if len(crowded) != 12 {
		t.Fatalf("200 turns made %d marks, want 12", len(crowded))
	}
	if pitch := 100 / float64(len(crowded)); pitch < axisTickGapMin {
		t.Fatalf("crowded pitch = %v, want at least %v", pitch, axisTickGapMin)
	}
	if crowded[0] != 0 || crowded[len(crowded)-1] != 199 {
		t.Fatalf("the sample dropped an end: %d … %d", crowded[0], crowded[len(crowded)-1])
	}
	for i := 1; i < len(crowded); i++ {
		if crowded[i] <= crowded[i-1] {
			t.Fatalf("marks are not ascending: %v", crowded)
		}
	}
	if got := planAxisTicks(1, 1); len(got) != 1 || got[0] != 0 {
		t.Fatalf("one turn in a short band planned %v, want [0]", got)
	}
	if got := planAxisTicks(200, 16); len(got) != 2 || got[0] != 0 || got[1] != 199 {
		t.Fatalf("two hit slots planned %v, want [0 199]", got)
	}
}

// turnAxisFixture mounts the actual ruler without session loading or agents.
func turnAxisFixture(t *testing.T, count int) *nsgotest.App {
	t.Helper()
	options := []nsgotest.Option{nsgotest.Size(1280, 860), nsgotest.Idiom(core.IdiomDesktop)}
	if nsgotest.Target() == "" {
		options = append(options, nsgotest.ManualFrames())
	}
	return nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a := &app{cx: cx, axisHover: core.NewSignal(cx, -1), axisHintIn: core.NewSignal(cx, false),
			reduceEffects: core.NewSignal(cx, false)}
		turns := make([]turn, count)
		tops := make(map[string]float64, count)
		for i := range turns {
			id := fmt.Sprintf("t%d", i)
			turns[i] = turn{ID: id, Prompt: fmt.Sprintf("Question %d", i+1)}
			tops[id] = float64(i * 100)
		}
		s := &session{turns: core.NewSignalFunc(cx, turns, nil), conversation: newChatScroll(cx), tops: tops}
		return core.View{TestID: "axis-fixture", Style: core.Style{Width: core.Pct(100), Height: core.Pct(100)}, Children: []core.Node{
			core.Scroll{Ref: s.conversation.Scroll(), TestID: "axis-transcript",
				Style:    core.Style{Width: core.Pct(100), Height: core.Pct(100)},
				Children: []core.Node{core.View{Style: core.Style{Width: core.Pct(100), Height: core.Pt(core.Points(max(3000, count*100)))}}}},
			a.turnAxis(s),
		}}
	}, options...)
}

// A single coordinate click anywhere in the hover slot must jump, including
// its blank corners and while the decorative bar is still growing.
func TestAxisTickHitArea(t *testing.T) {
	for _, count := range []int{3, 200} {
		for _, hover := range []bool{false, true} {
			t.Run(fmt.Sprintf("turns=%d/hover=%t", count, hover), func(t *testing.T) {
				screen := turnAxisFixture(t, count)
				row := screen.Find("id:axis-tick-0").Parent.Bounds()
				if row.Size.Height < axisTickGapMin || row.Size.Width != axisTickHit {
					t.Fatalf("hit slot = %+v, want width %v and height at least %v", row.Size, axisTickHit, axisTickGapMin)
				}
				points := []core.Point{
					{X: row.Origin.X + 1, Y: row.Origin.Y + 1},
					{X: row.Origin.X + row.Size.Width - 1, Y: row.Origin.Y + row.Size.Height - 1},
					{X: row.Origin.X + row.Size.Width/2, Y: row.Origin.Y + row.Size.Height/2},
				}
				for _, point := range points {
					screen.HoverOut()
					screen.Advance(200 * time.Millisecond)
					screen.ScrollTo("id:axis-transcript", core.Point{Y: 1000})
					if y := screen.Find("id:axis-transcript").Offset.Y; y != 1000 {
						t.Fatalf("scroll setup left offset %v, want 1000", y)
					}
					if hover {
						screen.HoverAt("id:axis-fixture", point)
						if got := screen.Find("id:axis-tick-0").Parent.Bounds(); got != row {
							t.Fatalf("hover moved hit slot from %+v to %+v", row, got)
						}
					}
					screen.PressAt("id:axis-fixture", point)
					screen.Advance(300 * time.Millisecond)
					if y := screen.Find("id:axis-transcript").Offset.Y; math.Abs(float64(y)) > 0.1 {
						t.Fatalf("one click at %+v left offset %v, want 0", point, y)
					}
				}
				// Existing selectors still activate the button through its bar.
				screen.ScrollTo("id:axis-transcript", core.Point{Y: 1000})
				screen.Press("id:axis-tick-0")
				screen.Advance(300 * time.Millisecond)
				if y := screen.Find("id:axis-transcript").Offset.Y; math.Abs(float64(y)) > 0.1 {
					t.Fatalf("selector click left offset %v, want 0", y)
				}
			})
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
	app := turnAxisFixture(t, 20)
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
	if height := app.Find("id:axis-tick-0").Frame.Size.Height; height != axisTickHeight {
		t.Fatalf("tick height = %v, want %v", height, axisTickHeight)
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
