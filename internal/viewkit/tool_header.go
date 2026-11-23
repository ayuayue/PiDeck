package viewkit

// A tool call's first line, drawn the same by the workbench's transcript and
// the phone or browser client: what ran, on what, what it changed, how long
// it took, and whether what it produced can be opened. The hosts fill it from
// the fields they own — pi's run in the workbench, the desktop's wire shape in
// the client — so only the glyphs, the verbs and the sizes are theirs.

import (
	"fmt"

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
	// DurationMs is how long it took: 0 while it runs, or when unknown.
	DurationMs int64
	Running    bool
	Failed     bool
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
	var header []core.Node
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
	if line.Running {
		header = append(header, ui.Spinner{Size: 10})
	} else if line.DurationMs > 0 {
		header = append(header, number(fmt.Sprintf("%d ms", line.DurationMs), colors.Faint()))
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
