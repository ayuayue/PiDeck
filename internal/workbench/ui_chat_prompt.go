//go:build !js && !android && !ios

package workbench

import (
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// turnPrompt is the user's side of a turn: a card on the paper, the time
// and the prompt's own actions under it. It is built once and reads its text
// in a binding, so a later message in the same turn does not redraw it.
func (a *app) turnPrompt(s *session, t func() turn) core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		images := t().Images
		present := func() bool { tt := t(); return tt.Prompt != "" || len(images) > 0 }
		return core.Show{When: present, Then: func(cx *core.Scope) core.Node {
			var content []core.Node
			if len(images) > 0 {
				tiles := make([]core.Node, 0, len(images))
				for _, img := range images {
					tiles = append(tiles, a.transcriptImageTile(img))
				}
				content = append(content, core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: tiles})
			}
			content = append(content, core.Text{ContentFunc: func() string { return t().Prompt }, TestID: "chat-prompt-text",
				Selectable: core.SelectableOn, Style: a.readingStyle(), StyleFunc: ui.Colored(colors.Text)})
			return core.View{Style: core.Style{AlignItems: core.AlignEnd, MinWidth: core.Pt(0), Gap: 4}, Children: []core.Node{
				core.View{TestID: "chat-prompt-bubble", Style: core.Style{MinWidth: core.Pt(0), MaxWidth: core.Pct(85),
					Padding: core.Symmetric(10, 12), Gap: 8, CornerRadius: 14, BorderWidth: 1},
					StyleFunc: func() core.Style {
						surface := colors.Surface()
						if cx.Dark() {
							surface = ui.Mix(surface, colors.Text(), 0.08)
						}
						return core.Style{Background: surface, BorderColor: colors.Border()}
					}, Children: content},
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					core.Show{When: func() bool { return !t().Start.IsZero() }, Then: func(*core.Scope) core.Node {
						return ui.Tabular(core.Text{ContentFunc: func() string { return clockTime(t().Start) }, TestID: "chat-prompt-time",
							Style: core.Style{FontSize: a.readingDetailFont(), LineHeight: a.readingDetailLine()}, StyleFunc: ui.Colored(colors.Faint)})
					}},
					a.promptActions(s, t),
				}},
			}}
		}}
	})
}
