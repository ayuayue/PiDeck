package viewkit

import (
	"math"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// phoneSizes is the line the client draws: the desktop passes its reading
// sizes through the same fields.
var phoneSizes = ToolSizes{Verb: 12, Detail: 10.5, Glyph: 13, Gap: 6, MinHeight: 26, PadV: 1, PadH: 2}

// toolRowScreen draws lines in the sizes the phone passes.
func toolRowScreen(t *testing.T, lines ...ToolLine) *nsgotest.App {
	t.Helper()
	return nsgotest.Start(t, func(cx *core.Scope) core.Node {
		cx.SetTheme(Theme())
		rows := make([]core.Node, 0, len(lines))
		for _, line := range lines {
			rows = append(rows, ToolRow(cx, line, phoneSizes))
		}
		return core.View{Style: core.Style{FontFamily: cx.Theme().Sans}, Children: rows}
	}, nsgotest.Size(420, 300))
}

// at is when a bounds' right edge falls: where right-aligned figures end.
func at(b core.Bounds) core.Points { return b.Origin.X + b.Size.Width }

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
	// A running call with no clock from its host says nothing about time and
	// has no failure label yet.
	if n := len(screen.Query("text:失败")); n != 0 {
		t.Fatalf("a running call showed 失败 %d times", n)
	}
	if n := len(screen.Query("text:0s")); n != 0 {
		t.Fatalf("a call with no clock showed one %d times", n)
	}
}

// TestToolRowCountsAndClock guards the numbers beside the verb: the lines it
// changed, the calls inside it, how long it took, and that it failed.
func TestToolRowCountsAndClock(t *testing.T) {
	screen := toolRowScreen(t, ToolLine{
		Glyph:   func() *core.SVG { return lucide.Pencil() },
		Verb:    "编辑",
		Detail:  "internal/client/state.go",
		Added:   3,
		Removed: 1,
		Nested:  2,
		Time:    func() string { return Duration(4200 * time.Millisecond) },
		Failed:  true,
	})
	for _, want := range []string{"+3", "−1", "内含 2 次调用", "4.2s", "失败"} {
		if len(screen.Query("text:"+want)) != 1 {
			t.Errorf("%q rows = %d; want 1", want, len(screen.Query("text:"+want)))
		}
	}
	// What it changed is left out of a call that changed nothing.
	quiet := toolRowScreen(t, ToolLine{Glyph: func() *core.SVG { return lucide.Terminal() }, Verb: "运行", Detail: "ls"})
	for _, unwanted := range []string{"+0", "−0", "失败"} {
		if n := len(quiet.Query("text:" + unwanted)); n != 0 {
			t.Errorf("a call with nothing to count showed %q %d times", unwanted, n)
		}
	}
}

// TestToolRowTimeFollowsTheVerb guards the order a row reads in: the glyph,
// what ran, how long it took, then what it ran on. The time sits between the
// verb and the details, and the details of two calls start on one line
// whatever each one took.
func TestToolRowTimeFollowsTheVerb(t *testing.T) {
	screen := toolRowScreen(t,
		ToolLine{Glyph: func() *core.SVG { return lucide.Terminal() }, Verb: "运行", Detail: "go vet ./internal/viewkit",
			Time: func() string { return Duration(8 * time.Millisecond) }},
		ToolLine{Glyph: func() *core.SVG { return lucide.Brain() }, Verb: "读取", Detail: "internal/viewkit/tool_header.go",
			Time: func() string { return Duration(4200 * time.Millisecond) }},
	)
	run, read := screen.Find("text:运行").Bounds(), screen.Find("text:读取").Bounds()
	if math.Abs(float64(run.Origin.X-read.Origin.X)) > 0.5 {
		t.Fatalf("the verbs start at %.1f and %.1f; want one line", run.Origin.X, read.Origin.X)
	}
	quick, slow := screen.Find("text:8ms").Bounds(), screen.Find("text:4.2s").Bounds()
	if quick.Origin.X <= at(run) {
		t.Fatalf("the time starts at %.1f, at or before its verb, which ends at %.1f", quick.Origin.X, at(run))
	}
	vet, header := screen.Find("text:go vet ./internal/viewkit").Bounds(), screen.Find("text:internal/viewkit/tool_header.go").Bounds()
	if math.Abs(float64(vet.Origin.X-header.Origin.X)) > 0.5 {
		t.Fatalf("the details start at %.1f and %.1f; want one column", vet.Origin.X, header.Origin.X)
	}
	for _, time := range []core.Bounds{quick, slow} {
		if at(time) >= vet.Origin.X {
			t.Fatalf("the time ends at %.1f, at or past the detail at %.1f", at(time), vet.Origin.X)
		}
	}
}

// TestDurationFitsTheTimeColumn guards the widths the column was sized for:
// six figures, so a block of durations stays inside its column whatever a
// call took, and no known time renders as nothing.
func TestDurationFitsTheTimeColumn(t *testing.T) {
	for _, d := range []time.Duration{0, 3 * time.Millisecond, 999 * time.Millisecond, time.Second,
		59_400 * time.Millisecond, 59*time.Minute + 59*time.Second, 23*time.Hour + 59*time.Minute} {
		if got := len(Duration(d)); got > 6 {
			t.Errorf("Duration(%v) = %q, %d figures; want at most 6", d, Duration(d), got)
		}
		if got := Duration(d); got == "" {
			t.Errorf("Duration(%v) = %q; want a time", d, got)
		}
	}
	// Unknown is the caller's to say: a negative span has no time.
	if got := Duration(-time.Second); got != "" {
		t.Errorf("Duration(-1s) = %q; want no time", got)
	}
}

// TestToolRowFillsTheTimeColumnEveryRow guards the column against holes: a
// call with no time recorded says so where the figures go, and the details
// after it start where a timed call's do.
func TestToolRowFillsTheTimeColumnEveryRow(t *testing.T) {
	screen := toolRowScreen(t,
		ToolLine{Glyph: func() *core.SVG { return lucide.Terminal() }, Verb: "运行", Detail: "ls -l",
			Time: func() string { return Duration(8 * time.Millisecond) }},
		ToolLine{Glyph: func() *core.SVG { return lucide.Terminal() }, Verb: "运行", Detail: "sleep 3"},
	)
	if n := len(screen.Query(`text:"` + NoTime + `"`)); n != 1 {
		t.Fatalf("rows saying %q = %d; want 1 for the call with no time", NoTime, n)
	}
	timed, plain := screen.Find("text:ls -l").Bounds(), screen.Find("text:sleep 3").Bounds()
	if math.Abs(float64(timed.Origin.X-plain.Origin.X)) > 0.5 {
		t.Fatalf("the details start at %.1f and %.1f; want one column", timed.Origin.X, plain.Origin.X)
	}
}
