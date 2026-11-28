//go:build !js && !android && !ios

package workbench

import (
	"fmt"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) delegationOverview(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		entries := a.sessionDelegations(s)
		if len(entries) == 0 {
			return nil
		}
		colors := ui.ColorsOf(cx)
		head := overviewLabel(colors, apptext.T("子代理与工作流"),
			ui.Tabular(core.Text{Content: fmt.Sprint(len(entries)),
				Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)}),
			overviewAction(colors, apptext.T("查看全部"), "delegate-show-all", func() {
				a.delegationSession.Set(s)
				a.openPane(paneDelegation)
			}))
		// Keep work that still needs attention ahead of finished history.
		ordered := make([]delegation, 0, len(entries))
		for _, active := range []bool{true, false} {
			for _, d := range entries {
				if d.active() == active {
					ordered = append(ordered, d)
				}
			}
		}
		var rows []core.Node
		for _, d := range ordered[:min(len(ordered), composerDelegationLimit)] {
			rows = append(rows, core.View{TestID: "delegate-run-" + d.CallID, Children: []core.Node{
				a.delegationOverviewRow(cx, s, d),
			}})
		}
		return overviewSection(colors, head, core.View{Style: core.Style{Direction: core.Column, Gap: 2}, Children: rows})
	})
}

func (a *app) delegationOverviewRow(cx *core.Scope, s *session, d delegation) core.Node {
	colors := ui.ColorsOf(cx)
	icon, ink := delegationTone(d.state, colors)
	return base.Button{TestID: "delegate-open-" + d.CallID, Label: firstNonEmpty(d.Detail, d.Name) + " · " + apptext.T(d.state),
		OnPress: func(core.PressEvent) { a.openDelegation(s, d) },
		Style:   core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(44), Padding: core.Symmetric(8, 4), CornerRadius: 8, MinWidth: core.Pt(0)},
		StyleFunc: func() core.Style {
			return core.Style{Hover: &core.Style{Background: colors.Hover()}, FocusVisible: ui.FocusRing(cx, 2)}
		},
		Children: []core.Node{
			ui.Icon(icon, 14, ink),
			core.Text{Content: firstNonEmpty(d.Detail, d.Name), MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FontSize: 13, LineHeight: 19, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Text)},
			ui.Text(apptext.T(d.state), 11, ui.Medium, ink),
			ui.Icon(lucide.ArrowUpRight, 12, colors.Muted),
		}}
}

// delegationPane is the whole history of the subagents and workflows a
// conversation handed work to. It projects the original tool records and
// completion notices; opening it never starts or resumes an agent.
func (a *app) delegationPane() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		s := a.delegationSession.Get()
		if s == nil {
			return core.View{Style: ui.FillRest}
		}
		colors := ui.ColorsOf(cx)
		// Keep the full history virtualized; results open only on demand.
		entries := core.NewMemoFunc(cx, func() []delegation { return a.sessionDelegations(s) }, nil)
		rows := core.List{TestID: "delegate-history-list", Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0),
			Padding: core.Edges{Right: scrollbarGutter}}, EstimatedSize: 37,
			Count: func() int { return len(entries.Get()) }, Key: func(i int) any { return entries.Get()[i].CallID },
			Empty: ui.Text(apptext.T("没有可识别的子代理或工作流记录。"), 12, ui.Regular, colors.Muted),
			Row: func(cx *core.Scope, row core.ListRow) core.Node {
				return core.Dynamic(func(cx *core.Scope) core.Node {
					list, i := entries.Get(), row.Index()
					if i < 0 || i >= len(list) {
						return nil
					}
					return a.delegationHistoryRow(cx, s, list[i])
				})
			}}
		return core.View{Style: core.Style{Direction: core.Column, FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), MinWidth: core.Pt(0)},
			Children: []core.Node{
				core.View{TestID: "delegate-history-heading", Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8,
					Height: core.Pt(48), MinWidth: core.Pt(0), FlexShrink: 0, Borders: core.Edges{Bottom: 1}, BorderColors: core.EdgeColors{Bottom: colors.Line()}}, Children: []core.Node{
					ui.Icon(lucide.Bot, 14, colors.Muted),
					ui.Text(apptext.T("子代理与工作流"), 13, ui.Semibold, colors.Text),
					ui.Text(apptext.T("当前会话"), 11, ui.Regular, colors.Muted),
					core.Text{ContentFunc: s.title.Get, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FontSize: 11, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Muted)},
					ui.Tabular(core.Text{ContentFunc: func() string { return fmt.Sprint(len(entries.Get())) },
						Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)}),
				}},
				rows,
			}}
	})
}

func (a *app) delegationHistoryRow(cx *core.Scope, s *session, d delegation) core.Node {
	colors := ui.ColorsOf(cx)
	key := s.ID + "/delegation/" + d.CallID
	open := func() bool { s.uiSeq.Get(); return s.procOpen(key, false) }
	icon, ink := delegationTone(d.state, colors)
	return core.View{TestID: "delegate-history-" + d.CallID,
		Style: core.Style{MinWidth: core.Pt(0), Borders: core.Edges{Bottom: 1}, BorderColors: core.EdgeColors{Bottom: colors.Line()}}, Children: []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, MinWidth: core.Pt(0)}, Children: []core.Node{
				base.Button{TestID: "delegate-history-toggle-" + d.CallID, Label: firstNonEmpty(d.Detail, d.Name), Expanded: open,
					OnPress: func(core.PressEvent) { s.toggleProc(key, false) },
					Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(36),
						FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), CornerRadius: ui.RadiusSmall, Padding: core.Symmetric(0, 4)},
					StyleFunc: func() core.Style {
						return core.Style{Hover: &core.Style{Background: colors.Hover()}, FocusVisible: ui.FocusRing(cx, 2)}
					}, Children: []core.Node{
						ui.IconOf(disclosure(open), 11, colors.Muted),
						core.Text{Content: firstNonEmpty(d.Detail, d.Name), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{FontSize: 12, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Text)},
						ui.Text(apptext.T(d.Action), 10.5, ui.Regular, colors.Muted),
						ui.Icon(icon, 11, ink),
						ui.Text(apptext.T(d.state), 11, ui.Medium, ink),
					}},
				hint(apptext.T("在对话中查看"), ui.IconButton{Icon: lucide.ArrowUpRight, Label: apptext.T("在对话中查看"),
					Size: 26, IconSize: 12, TestID: "delegate-history-open-" + d.CallID, OnPress: func() {
						a.closePane(paneDelegation)
						a.openDelegation(s, d)
					}}),
			}},
			core.Show{When: open, Then: func(*core.Scope) core.Node {
				details := []core.Node{core.Text{Content: firstNonEmpty(d.Detail, d.Name), MaxLines: 3, Selectable: core.SelectableOn,
					Style: core.Style{FontSize: 12}, StyleFunc: ui.Colored(colors.Text)}}
				for _, step := range d.Nested[:min(len(d.Nested), 8)] {
					details = append(details, core.Text{Content: step, MaxLines: 2,
						Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)})
				}
				if d.Output != "" {
					details = append(details, core.Scroll{TestID: "delegate-history-result-" + d.CallID,
						Style: core.Style{MaxHeight: core.Pt(240), MinWidth: core.Pt(0)}, Children: []core.Node{
							core.Text{Content: shorten(d.Output, 16000), Selectable: core.SelectableOn,
								Style: core.Style{FontSize: 11, Padding: core.Edges{Right: scrollbarGutter}}, StyleFunc: ui.Colored(colors.Muted)},
						}})
				}
				return core.View{Style: core.Style{Gap: 6, MinWidth: core.Pt(0), Padding: core.Edges{Left: 23, Right: 30, Bottom: 10}}, Children: details}
			}},
		}}
}
