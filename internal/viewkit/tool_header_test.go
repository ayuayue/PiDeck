package viewkit

import (
	"testing"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// toolRowScreen draws one line in the sizes the phone passes.
func toolRowScreen(t *testing.T, line ToolLine) *nsgotest.App {
	t.Helper()
	return nsgotest.Start(t, func(cx *core.Scope) core.Node {
		cx.SetTheme(Theme())
		return core.View{Style: core.Style{FontFamily: cx.Theme().Sans}, Children: []core.Node{
			ToolRow(cx, line, ToolSizes{Verb: 12, Detail: 10.5, Glyph: 13, Gap: 6, MinHeight: 26, PadV: 1, PadH: 2}),
		}}
	}, nsgotest.Size(420, 300))
}

// TestToolRowShowsOneCall guards the line the workbench and the client both
// draw: what ran and on what always, and the counts, the clock and the
// failure only when the call has them.
func TestToolRowShowsOneCall(t *testing.T) {
	screen := toolRowScreen(t, ToolLine{
		Glyph:   func() *core.SVG { return lucide.Terminal() },
		Verb:    "运行",
		Detail:  "go test ./internal/client",
		Running: true,
		HasBody: true,
	})
	if len(screen.Query("text:运行")) != 1 {
		t.Fatalf("verb rows = %d; want 1", len(screen.Query("text:运行")))
	}
	if len(screen.Query("text:go test ./internal/client")) != 1 {
		t.Fatalf("detail rows = %d; want 1", len(screen.Query("text:go test ./internal/client")))
	}
	// A running call has no clock and no failure label yet.
	if n := len(screen.Query("text:失败")); n != 0 {
		t.Fatalf("a running call showed 失败 %d times", n)
	}
	if n := len(screen.Query("text:ms")); n != 0 {
		t.Fatalf("a running call showed its clock %d times", n)
	}
}

// TestToolRowCountsAndClock guards the numbers next to the verb: the lines it
// changed, the calls inside it, how long it took, and that it failed.
func TestToolRowCountsAndClock(t *testing.T) {
	screen := toolRowScreen(t, ToolLine{
		Glyph:      func() *core.SVG { return lucide.Pencil() },
		Verb:       "编辑",
		Detail:     "internal/client/state.go",
		Added:      3,
		Removed:    1,
		Nested:     2,
		DurationMs: 4200,
		Failed:     true,
	})
	for _, want := range []string{"+3", "−1", "内含 2 次调用", "4200 ms", "失败"} {
		if len(screen.Query("text:"+want)) != 1 {
			t.Errorf("%q rows = %d; want 1", want, len(screen.Query("text:"+want)))
		}
	}
	// What it changed is left out of a call that changed nothing.
	quiet := toolRowScreen(t, ToolLine{Glyph: func() *core.SVG { return lucide.Terminal() }, Verb: "运行", Detail: "ls"})
	for _, unwanted := range []string{"+0", "−0", "ms"} {
		if n := len(quiet.Query("text:" + unwanted)); n != 0 {
			t.Errorf("a call with nothing to count showed %q %d times", unwanted, n)
		}
	}
}
