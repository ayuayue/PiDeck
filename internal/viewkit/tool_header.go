package viewkit

// A tool call's first line, drawn the same by the workbench's transcript and
// the phone or browser client: how long it took, what ran, on what, what it
// changed, and whether what it produced can be opened. The hosts fill it from
// the fields they own — pi's run in the workbench, the desktop's wire shape in
// the client — so only the glyphs, the verbs and the sizes are theirs.

import (
	"fmt"
	"math"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// ToolLine is one tool call as its first line shows it.
type ToolLine struct {
	// Glyph is the icon of what the call does; nil leaves the icon out.
	Glyph func() *core.SVG
	// Verb says what it did, Detail is what it did it to.
	Verb, Detail string
	// Added and Removed are the lines it changed, Nested the calls it made.
	Added, Removed, Nested int
	// Time is how long the call took, already written: a finished call's
	// total, or what a running one has spent so far. A running call counts
	// up, so the row asks again whenever it paints; nil has no clock to show.
	Time    func() string
	Running bool
	Failed  bool
	// Open and HasBody drive the arrow: an open row shows its output, and a
	// row with nothing to show has no arrow.
	Open, HasBody bool
}

// ToolSizes is a line's type and the room around it: the desktop's reading
// size, or the phone's. Glyph also sets the arrow's size, two points smaller.
type ToolSizes struct {
	Verb, Detail, Glyph core.Points
	Gap, MinHeight      core.Points
	PadV, PadH          core.Points
}

// ToolRow is one tool call's header. The caller owns the click, the label
// and the body under it; this is only the line that opens it.
func ToolRow(cx *core.Scope, line ToolLine, sizes ToolSizes) core.Node {
	colors := ui.ColorsOf(cx)
	// Numbers line up under each other as they change under the eye.
	number := func(text string, ink core.Color) core.Node {
		return ui.Tabular(core.Text{Content: text, MaxLines: 1,
			Style:     core.Style{FontFamily: MonoFont(), FontSize: sizes.Detail, FlexShrink: 0},
			StyleFunc: ui.Colored(func() core.Color { return ink })})
	}
	// How long the call took heads the row, in a column of its own: the
	// figures line up down a block of calls, and what ran keeps the room
	// they would otherwise take at its end.
	header := []core.Node{TimeCell(cx, sizes.Detail, line.Running, line.Time)}
	if line.Glyph != nil {
		header = append(header, ui.IconOf(line.Glyph, sizes.Glyph, func() core.Color {
			switch {
			case line.Failed:
				return colors.Danger()
			case line.Running:
				return colors.Info()
			}
			return colors.Muted()
		}))
	}
	header = append(header,
		core.Text{Content: line.Verb, MaxLines: 1,
			Style:     core.Style{FontSize: sizes.Verb, FontWeight: ui.Medium, FlexShrink: 0},
			StyleFunc: ui.Colored(colors.Muted)},
		core.Text{Content: line.Detail, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
			Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: MonoFont(), FontSize: sizes.Detail},
			StyleFunc: ui.Colored(colors.Faint)})
	if line.Added > 0 || line.Removed > 0 {
		header = append(header, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, FlexShrink: 0},
			Children: []core.Node{
				number(fmt.Sprintf("+%d", line.Added), colors.Up()),
				number(fmt.Sprintf("−%d", line.Removed), colors.Danger()),
			}})
	}
	if line.Nested > 0 {
		header = append(header, number(apptext.T("内含 %d 次调用", line.Nested), colors.Faint()))
	}
	if line.Failed {
		header = append(header, core.Text{Content: apptext.T("失败"), MaxLines: 1,
			Style:     core.Style{FontSize: sizes.Detail, FontWeight: ui.Medium, FlexShrink: 0},
			StyleFunc: ui.Colored(colors.Danger)})
	}
	if line.HasBody {
		header = append(header, ui.IconOf(func() *core.SVG {
			if line.Open {
				return lucide.ChevronDown()
			}
			return lucide.ChevronRight()
		}, sizes.Glyph-2, colors.Faint))
	}
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: sizes.Gap,
		MinHeight: core.Pt(sizes.MinHeight), Padding: core.Symmetric(sizes.PadV, sizes.PadH), MinWidth: core.Pt(0)},
		Children: header}
}

// TimeCell is one row's leading time column: how long it took, right-aligned
// so the figures line up, a spinner for a running row that has no clock yet,
// and nothing for a row with no time at all. The column keeps its width in
// every case, so the glyphs and the words of the rows around it stay on one
// vertical line.
func TimeCell(cx *core.Scope, size core.Points, running bool, text func() string) core.Node {
	colors := ui.ColorsOf(cx)
	var slot core.Node = core.View{}
	switch {
	case text != nil && text() != "":
		slot = ui.Tabular(core.Text{ContentFunc: text, MaxLines: 1,
			Style:     core.Style{FontFamily: MonoFont(), FontSize: size, FlexShrink: 0},
			StyleFunc: ui.Colored(colors.Faint)})
	case running:
		slot = ui.Spinner{Size: max(size-2, 8)}
	}
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, JustifyContent: core.JustifyEnd,
		Width: core.Pt(TimeWidth(size)), FlexShrink: 0, Margin: core.Edges{Right: timeGap(size)}},
		Children: []core.Node{slot}}
}

// ContentLeft is where a row's own words begin: past the time column, the
// glyph and their gaps. A body under a row starts here too, so opening it
// drops its output into the row's column instead of beside it.
func ContentLeft(sizes ToolSizes) core.Points {
	return sizes.PadH + TimeWidth(sizes.Detail) + timeGap(sizes.Detail) + sizes.Gap + sizes.Glyph + sizes.Gap
}

// TimeWidth is the room a time column takes: six monospaced figures, the
// longest a call's time gets ("59m59s", "23h59m"), so every row's duration
// ends on the same vertical line.
func TimeWidth(size core.Points) core.Points {
	return core.Points(math.Ceil(float64(size) * monoAdvance * 6))
}

// monoAdvance is how much of its size one figure of MonoFont takes: SF Mono,
// Menlo and Liberation Mono take 0.60, Consolas 0.55. The rest leaves room
// for a fallback face.
const monoAdvance = 0.63

// timeGap is the extra air between a time and what ran, on top of the row's
// own gap: the figures read as a column of their own rather than another
// word of the line.
func timeGap(size core.Points) core.Points { return core.Points(math.Round(float64(size) * 0.35)) }
