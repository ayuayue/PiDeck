//go:build !js && !android && !ios

package workbench

// The ACP composer's own pickers: the model and the thinking level an agent
// reports as config options. They sit beside the badge so the choice in
// force is visible without opening the agent's panel; each opens a bounded
// list of its own instead of one long page of every option.

import (
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// acpPopover bounds a picker to one width, so a long option description
// cannot stretch it across the window.
func (a *app) acpPopover(open *core.Signal[bool], width core.Points, trigger core.Node,
	content func(cx *core.Scope) core.Node, testID string) base.Popover {
	pop := a.popoverCard(open, core.PlaceTop, core.AlignStart, width, trigger, content, testID)
	pop.PopupStyle = core.Style{Width: core.Pt(width), MaxWidth: core.Pt(width)}
	return pop
}

// acpOptionChip is the trigger of one picker: the icon, the value in force
// and a caret, on the composer's control row.
func acpOptionChip(cx *core.Scope, icon func() *core.SVG, label, testID string, press func()) core.Node {
	colors := ui.ColorsOf(cx)
	return hintOf(func() string { return label }, core.View{
		OnPress: func(core.PressEvent) { press() },
		Role:    core.RoleButton, Label: label, TestID: testID,
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Height: core.Pt(26),
				FlexShrink: 1, MinWidth: core.Pt(0), Padding: core.Symmetric(0, 7), CornerRadius: 7,
				Transition: viewkit.PressMotion, Hover: &core.Style{Background: colors.Hover()}}
		},
		Children: []core.Node{
			ui.Icon(icon, 12, colors.Muted),
			core.Text{Content: label, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FontSize: 11.5, MinWidth: core.Pt(0), FlexShrink: 1}, StyleFunc: ui.Colored(colors.Text)},
			ui.Icon(lucide.ChevronDown, 9.5, colors.Faint),
		},
	})
}

// acpOptionLabel is the word a picker shows for its option now; fallback
// names the control while the agent's own choice has no name.
func acpOptionLabel(options []acpConfigOption, kind acpOptionKind, fallback string) string {
	option := acpOptionByKind(options, kind)
	if option == nil || option.isBool() {
		return ""
	}
	return firstNonEmpty(option.currentChoiceLabel(), fallback)
}

// acpOptionRows are the choice rows of one select inside its own scroll:
// one list per picker, not a scroll per group.
func (a *app) acpOptionRows(cx *core.Scope, s *session, option acpConfigOption, maxHeight core.Points, close func()) core.Node {
	return core.Scroll{Style: core.Style{MaxHeight: core.Pt(maxHeight), MinWidth: core.Pt(0)},
		Children: []core.Node{core.View{Style: core.Style{Padding: core.Edges{Right: viewkit.PanelInset}},
			Children: []core.Node{a.acpChoiceRows(cx, s, option, close)}}}}
}

// acpChoiceRows draws a select's choices without a scroll of its own, so a
// panel can put several selects in the one scroll it already has.
func (a *app) acpChoiceRows(cx *core.Scope, s *session, option acpConfigOption, close func()) core.Node {
	colors := ui.ColorsOf(cx)
	changing := s.acpOptionBusy.Get() || s.runningSig.Get() || !s.readySig.Get()
	rows := core.Dynamic(func(cx *core.Scope) core.Node {
		query := ""
		if option.kind() == acpOptionModel {
			query = strings.ToLower(strings.TrimSpace(s.modelQuery.Get()))
		}
		// The agent may replace its table while the picker is open; read
		// the option again so the checks follow the new values.
		live := acpOptionByID(s.acpOptions.Get(), option.ID)
		if live == nil || live.isBool() {
			return nil
		}
		var choices []core.Node
		for _, choice := range live.Choices() {
			if !acpChoiceMatches(choice, query) {
				continue
			}
			value := choice.Value
			row := composerRow(cx, nil, firstNonEmpty(choice.Name, value), choice.Description,
				value == live.CurrentValue.text(), changing, func() {
					if close != nil {
						close()
					}
					a.chooseACPOption(s, live.ID, acpTextValue(value))
				})
			row.TestID = "acp-option-" + live.ID + "-" + value
			choices = append(choices, row)
		}
		if len(choices) == 0 {
			if option.kind() != acpOptionModel {
				return nil
			}
			return core.View{Style: core.Style{Padding: core.Symmetric(14, 8)}, Children: []core.Node{
				core.Text{Content: apptext.T("没有匹配的模型"), MaxLines: 2,
					Style: core.Style{FontSize: 12, TextAlign: core.TextAlignCenter}, StyleFunc: ui.Colored(colors.Faint)}}}
		}
		return core.View{Style: core.Style{Gap: 1, MinWidth: core.Pt(0)}, Children: choices}
	})
	return rows
}

// acpChoiceMatches filters a choice by its words, so a long model list is
// findable by name, id or the price line under it.
func acpChoiceMatches(choice acpConfigChoice, query string) bool {
	if query == "" {
		return true
	}
	return strings.Contains(strings.ToLower(choice.Name), query) ||
		strings.Contains(strings.ToLower(choice.Value), query) ||
		strings.Contains(strings.ToLower(choice.Description), query)
}

// acpModelChip is the model in force. The list is searchable because an
// agent can offer a long catalogue, and it closes on the choice so the
// composer shows the new name at once.
func (a *app) acpModelChip(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		option := acpOptionByKind(s.acpOptions.Get(), acpOptionModel)
		if option == nil || option.isBool() || len(option.Choices()) == 0 {
			return nil
		}
		label := shorten(acpOptionLabel(s.acpOptions.Get(), acpOptionModel, apptext.T("模型")), 24)
		trigger := acpOptionChip(cx, lucide.Cpu, label, "acp-model-chip", func() {
			if !s.modelOpen.GetUntracked() {
				s.modelQuery.Set("")
			}
			s.modelOpen.Update(func(v bool) bool { return !v })
		})
		return a.acpPopover(s.modelOpen, 360, trigger, func(cx *core.Scope) core.Node {
			live := acpOptionByKind(s.acpOptions.Get(), acpOptionModel)
			if live == nil || live.isBool() {
				return nil
			}
			rows := []core.Node{composerPanelTitle(cx, firstNonEmpty(live.Name, apptext.T("模型")))}
			if len(live.Choices()) > 6 {
				rows = append(rows, acpModelSearch(cx, s))
			}
			rows = append(rows, a.acpOptionRows(cx, s, *live, 320, func() { s.modelOpen.Set(false) }))
			return core.View{TestID: "acp-model-panel", Style: core.Style{Gap: 3, MinWidth: core.Pt(0)}, Children: rows}
		}, "acp-model-menu")
	})
}

// acpModelSearch filters the model list without rebuilding the field it is
// typed into: the field reads the query, the rows below read it too.
func acpModelSearch(cx *core.Scope, s *session) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{StyleFunc: func() core.Style {
		return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Height: core.Pt(30), Padding: core.Symmetric(0, 8),
			Margin: core.Edges{Bottom: 3}, CornerRadius: 6, BorderWidth: 1, BorderColor: colors.FieldBorder(), Background: colors.Field()}
	}, Children: []core.Node{
		ui.Icon(lucide.Search, 12, colors.Faint),
		core.Input{Value: s.modelQuery.Get, OnChange: s.modelQuery.Set, AutoFocus: true,
			Placeholder: apptext.T("搜索模型或供应商"), Label: apptext.T("搜索模型"), TestID: "acp-model-search",
			Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0), FontSize: 12, Color: colors.Text()},
			StyleFunc: func() core.Style {
				return core.Style{PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
			}},
	}}
}

// acpThinkChip is the reasoning level in force. It stays a short list: an
// agent offers a handful of levels, and the chip names the one chosen.
func (a *app) acpThinkChip(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		option := acpOptionByKind(s.acpOptions.Get(), acpOptionThinking)
		if option == nil || option.isBool() || len(option.Choices()) == 0 {
			return nil
		}
		label := shorten(acpOptionLabel(s.acpOptions.Get(), acpOptionThinking, apptext.T("思考")), 14)
		trigger := acpOptionChip(cx, lucide.Brain, label, "acp-think-chip", func() {
			s.acpThinkOpen.Update(func(v bool) bool { return !v })
		})
		return a.acpPopover(s.acpThinkOpen, 300, trigger, func(cx *core.Scope) core.Node {
			live := acpOptionByKind(s.acpOptions.Get(), acpOptionThinking)
			if live == nil || live.isBool() {
				return nil
			}
			rows := []core.Node{composerPanelTitle(cx, firstNonEmpty(live.Name, apptext.T("思考"))),
				a.acpOptionRows(cx, s, *live, 260, func() { s.acpThinkOpen.Set(false) })}
			return core.View{TestID: "acp-think-panel", Style: core.Style{Gap: 3, MinWidth: core.Pt(0)}, Children: rows}
		}, "acp-think-menu")
	})
}
