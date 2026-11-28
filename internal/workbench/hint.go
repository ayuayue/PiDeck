//go:build !js && !android && !ios

package workbench

import (
	"time"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// hint shows a label while the pointer rests on a control. ui.Button and
// ui.IconButton take a Label for assistive technology only, so the app
// wraps what has no words of its own.
func hint(label string, n core.Node) core.Node {
	return hintOf(func() string { return apptext.T(label) }, n)
}

// hintOf is hint for a label that can change, such as a translated one or
// one naming the session in front.
//
// The bubble is the app's own rather than the kit's default: that one
// paints it in the text's color with the page's color for the words, which
// in a dark theme leaves a bright bubble over a dark window. A surface
// card reads the same in both themes.
func hintOf(label func() string, n core.Node) core.Node {
	return base.Tooltip{
		Trigger: n,
		Style:   core.Style{FlexShrink: 0},
		Delay:   250 * time.Millisecond,
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			return hintCard(cx, label)
		})},
	}
}

// hintCard is what a hint is written on: an opaque card, so a theme that
// sees through its panels (a wallpaper) never leaves the words over the
// page with nothing behind them.
func hintCard(cx *core.Scope, label func() string) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{Style: core.Style{CornerRadius: 7, Padding: core.Symmetric(4, 8), MaxWidth: core.Pt(300),
		Background: ui.Alpha(colors.Surface(), 1), BorderWidth: 1, BorderColor: colors.Border(),
		Shadows: []core.BoxShadow{ui.Shadow(0, 8, 22, 0, ui.Black(0.16))}},
		Children: []core.Node{core.Text{ContentFunc: label, MaxLines: 3, EllipsizeMode: core.EllipsizeTail,
			Style: core.Style{FontSize: 11.5, LineHeight: 16}, StyleFunc: ui.Colored(colors.Text)}}}
}
