//go:build !js && !android && !ios

package workbench

import (
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// turnPrompt owns the app's outgoing surface; Turn still owns the SDK's
// process lifecycle. PiDeck uses a white card on paper, with time outside.
func (a *app) turnPrompt(t func() turn) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		tt := t()
		var content []core.Node
		if len(tt.Images) > 0 {
			images := make([]core.Node, 0, len(tt.Images))
			for _, img := range tt.Images {
				images = append(images, a.transcriptImageTile(img))
			}
			content = append(content, core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: images})
		}
		if tt.Prompt != "" {
			content = append(content, core.Text{Content: tt.Prompt, TestID: "chat-prompt-text", Selectable: core.SelectableOn,
				Style: a.readingStyle(), StyleFunc: ui.Colored(colors.Text)})
		}
		if len(content) == 0 {
			return nil
		}
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
			core.Show{When: func() bool { return !t().Start.IsZero() }, Then: func(*core.Scope) core.Node {
				return ui.Tabular(core.Text{ContentFunc: func() string { return clockTime(t().Start) }, TestID: "chat-prompt-time",
					Style: core.Style{FontSize: a.readingDetailFont(), LineHeight: a.readingDetailLine()}, StyleFunc: ui.Colored(colors.Faint)})
			}},
		}}
	})
}
