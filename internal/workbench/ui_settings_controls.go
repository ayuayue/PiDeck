//go:build !js && !android && !ios

package workbench

// The settings window: a rail of sections beside the section's rows. Each
// row says what it is in a line and why in a quieter one, and the control
// sits at its end, so a section reads top to bottom.

import (
	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// setGroup is a headed block of rows.
func setGroup(title string, rows ...core.Node) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return core.View{Style: core.Style{Gap: 6, Margin: core.Edges{Bottom: 14}}, Children: []core.Node{
			core.Text{Content: apptext.T(title), Role: core.RoleHeader,
				Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: 18, FontWeight: ui.Medium}, StyleFunc: ui.Colored(colors.Muted)},
			core.View{StyleFunc: func() core.Style {
				return core.Style{Gap: 2, Padding: core.Symmetric(4, 10), CornerRadius: 9,
					BorderWidth: 1, BorderColor: colors.Now().Line, Background: colors.Surface()}
			}, Children: rows},
		}}
	})
}

// setRow is a row: what it is, why, and the control.
func setRow(label, help string, control core.Node) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		texts := []core.Node{
			core.Text{Content: apptext.T(label), Style: core.Style{FontSize: viewkit.PanelTextSize, LineHeight: viewkit.PanelLineHeight}, StyleFunc: ui.Colored(colors.Text)},
		}
		if help != "" {
			texts = append(texts, core.Text{Content: apptext.T(help),
				Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: 18}, StyleFunc: ui.Colored(colors.Muted)})
		}
		children := []core.Node{core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, FlexBasis: core.Pt(260), MinWidth: core.Pt(0), Gap: 1}, Children: texts}}
		if control != nil {
			children = append(children, core.View{Style: core.Style{FlexShrink: 1, MinWidth: core.Pt(0), MaxWidth: core.Pct(100)}, Children: []core.Node{control}})
		}
		return core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, AlignItems: core.AlignCenter, Gap: 12, MinHeight: core.Pt(38),
			Padding: core.Symmetric(3, 2)}, Children: children}
	})
}

// choice is one option of choiceChips.
type choice[T comparable] struct {
	Value T
	Label string
}

func languageOptions() []ui.Option[string] {
	options := []ui.Option[string]{{Value: apptext.LangSystem, Label: apptext.LanguageName(apptext.LangSystem)}}
	for _, code := range apptext.SupportedLanguages {
		options = append(options, ui.Option[string]{Value: code, Label: apptext.LanguageName(code)})
	}
	return options
}

// choiceChips is a row of small options, one of them chosen.
func choiceChips[V comparable](options []choice[V], value func() V, onPick func(V)) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		var chips []core.Node
		for _, o := range options {
			opt := o
			on := func() bool { return value() == opt.Value }
			chips = append(chips, core.View{
				OnPress: func(core.PressEvent) { onPick(opt.Value) },
				Role:    core.RoleRadio, Label: apptext.T(opt.Label),
				StyleFunc: func() core.Style {
					st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Height: core.Pt(24), Padding: core.Symmetric(0, 9),
						CornerRadius: 12, BorderWidth: 1, BorderColor: colors.Border(), Hover: &core.Style{Background: colors.Hover()}}
					if on() {
						st.Background = colors.Pressed()
						st.BorderColor = colors.Text()
					}
					return st
				},
				Children: []core.Node{ui.Text(apptext.T(opt.Label), viewkit.PanelTextSize, ui.Regular, colors.Text)},
			})
		}
		return core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 5}, Children: chips}
	})
}

// setDivider is the hairline between rows.
func setDivider() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		return core.View{Style: core.Style{Height: core.Pt(1), Margin: core.Edges{Left: 2}}, StyleFunc: ui.Filled(ui.ColorsOf(cx).Line)}
	})
}

func settingsSelectStyle() core.Style {
	return core.Style{Width: core.Pt(230), MaxWidth: core.Pct(100), Height: core.Pt(viewkit.PanelControlSize), FontSize: viewkit.PanelTextSize, LineHeight: viewkit.PanelLineHeight}
}

// settingsSlider gives each slider the same track, readout and endpoint columns.
func settingsSlider(slider ui.Slider, value func() string, low, high string) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignStart, Gap: 8, Width: core.Pt(230), MaxWidth: core.Pct(100)}, Children: []core.Node{
			core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0), Gap: 2}, Children: []core.Node{
				slider,
				core.View{Style: core.Style{Direction: core.Row, JustifyContent: core.JustifySpaceBetween}, Children: []core.Node{
					ui.Text(apptext.T(low), viewkit.PanelMicroSize, ui.Regular, colors.Muted),
					ui.Text(apptext.T(high), viewkit.PanelMicroSize, ui.Regular, colors.Muted),
				}},
			}},
			core.Text{ContentFunc: value, TestID: slider.TestID + "-value",
				Style:     core.Style{Width: core.Pt(76), FlexShrink: 0, TextAlign: core.TextAlignRight, FontSize: viewkit.PanelCaptionSize, LineHeight: viewkit.PanelLineHeight},
				StyleFunc: ui.Colored(colors.Text)},
		}}
	})
}
