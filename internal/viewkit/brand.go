package viewkit

// A name and the brand behind it. The providers, models and agents the app
// lists are all names someone else chose, so the mark is looked up rather than
// known: what the set does not know is a name with no picture, never an empty
// box that pushes the row out of line. Both hosts read a list the same way.

import (
	"example.com/pideck-v2/internal/viewkit/brands"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// BrandName is label after the mark of hint, size points square. The label
// gives up width to the mark, so a long model name still ends in an ellipsis
// inside its row instead of pushing the row's trailing controls out.
func BrandName(colors ui.Colors, hint string, size core.Points, label core.Text) core.Node {
	mark := brands.Mark(hint, size, colors.Muted)
	if mark == nil {
		return label
	}
	label.Style.FlexShrink, label.Style.MinWidth = 1, core.Pt(0)
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinWidth: core.Pt(0)},
		Children: []core.Node{mark, label}}
}
