//go:build !js && !android && !ios

package workbench

// The composer keeps the current delegation context close to the input.
// Activity is a projection of the same tool/session records as the drawer;
// opening or folding it never owns a separate copy of agent state.

import (
	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

const composerDelegationLimit = 4

func (a *app) subagentComposerBar(s *session) core.Node {
	return core.Group{a.composerParentContext(s), core.Dynamic(func(cx *core.Scope) core.Node {
		s.uiSeq.Get()
		entries := a.sessionDelegations(s)
		if len(entries) == 0 {
			return nil
		}
		colors := ui.ColorsOf(cx)
		active := 0
		for _, d := range entries {
			if d.active() {
				active++
			}
		}
		key := s.ID + "/delegations"
		open := func() bool { s.uiSeq.Get(); return s.procOpen(key, active > 0) }
		var parts []core.Node
		parts = append(parts, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinWidth: core.Pt(0)},
			Children: []core.Node{
				base.Button{TestID: "composer-delegation-toggle", Label: apptext.T("子代理与工作流"), Expanded: open,
					OnPress: func(core.PressEvent) { s.toggleProc(key, active > 0) },
					Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0),
						MinHeight: core.Pt(28), CornerRadius: ui.RadiusControl},
					StyleFunc: func() core.Style { return core.Style{FocusVisible: ui.FocusRing(cx, 2)} }, Children: []core.Node{
						ui.Icon(lucide.Bot, 13, colors.Muted),
						core.Text{Content: apptext.T("子代理与工作流"), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{MinWidth: core.Pt(0), FlexShrink: 1, FontSize: 11.5, FontWeight: ui.Medium}, StyleFunc: ui.Colored(colors.Text)},
						ui.Text(apptext.T("当前会话"), 10.5, ui.Regular, colors.Muted),
						core.Text{Content: apptext.T("%d 进行中 · 共 %d 项", active, len(entries)), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{MinWidth: core.Pt(0), FlexShrink: 1, FontSize: 10.5}, StyleFunc: ui.Colored(colors.Muted)},
						ui.IconOf(disclosure(open), 11, colors.Faint),
					}},
				ui.Button{Text: apptext.T("查看全部"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "composer-delegation-all",
					OnPress: func() { a.delegationSession.Set(s); a.openPane(paneDelegation) }},
			}})
		parts = append(parts, core.Show{When: open, Then: func(*core.Scope) core.Node {
			return core.List{TestID: "composer-delegation-list", EstimatedSize: 28,
				Style: core.Style{Height: core.Pt(core.Points(min(len(entries), composerDelegationLimit) * 28)), MinWidth: core.Pt(0),
					FlexShrink: 0, Padding: core.Edges{Right: scrollbarGutter}},
				Count: func() int { return len(entries) }, Key: func(i int) any { return entries[i].CallID },
				Row: func(cx *core.Scope, row core.ListRow) core.Node {
					return core.Dynamic(func(cx *core.Scope) core.Node {
						i := row.Index()
						if i < 0 || i >= len(entries) {
							return nil
						}
						d := entries[i]
						return a.delegationSummaryRow(cx, s, d, "composer-delegation-"+d.CallID)
					})
				}}
		}})
		return core.View{TestID: "composer-delegations", Style: core.Style{Padding: core.Edges{Bottom: 6}}, Children: []core.Node{
			core.View{StyleFunc: func() core.Style {
				return core.Style{Gap: 3, MinWidth: core.Pt(0), Padding: core.Symmetric(4, 10), CornerRadius: ui.RadiusControl,
					Background: ui.Alpha(colors.Surface(), 1), BorderWidth: 1, BorderColor: colors.Border()}
			}, Children: parts},
		}}
	})}
}

func (a *app) delegationSummaryRow(cx *core.Scope, s *session, d delegation, testID string) core.Node {
	colors := ui.ColorsOf(cx)
	icon, ink := delegationTone(d.state, colors)
	return base.Button{TestID: testID,
		Label:   firstNonEmpty(d.Detail, d.Name) + " · " + apptext.T(d.state),
		OnPress: func(core.PressEvent) { a.openDelegation(s, d) },
		Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, MinWidth: core.Pt(0),
			Height: core.Pt(28), Padding: core.Symmetric(3, 2), CornerRadius: ui.RadiusSmall},
		StyleFunc: func() core.Style {
			return core.Style{Hover: &core.Style{Background: colors.Hover()}, FocusVisible: ui.FocusRing(cx, 2)}
		}, Children: []core.Node{
			ui.Icon(icon, 12, ink),
			core.Text{Content: firstNonEmpty(d.Detail, d.Name), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11.5}, StyleFunc: ui.Colored(colors.Text)},
			ui.Text(apptext.T(d.state), 10.5, ui.Medium, ink),
			ui.Icon(lucide.ArrowUpRight, 11, colors.Faint),
		}}
}

// A child/fork's input names its parent and its current task. Relationship
// resolution is shared with the rail, including user links and late scans.
func (a *app) composerParentContext(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		s.uiSeq.Get()
		parent, _ := a.sessionRelations(s)
		if parent == nil {
			return nil
		}
		colors := ui.ColorsOf(cx)
		return core.View{TestID: "composer-subagent-context", Style: core.Style{Gap: 2, Padding: core.Edges{Left: 6, Right: 6, Bottom: 6}}, Children: []core.Node{
			core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, AlignItems: core.AlignCenter, Gap: 5, MinWidth: core.Pt(0)}, Children: []core.Node{
				base.Button{TestID: "composer-subagent-parent", LabelFunc: func() string { return apptext.T("父会话 · %s", parent.title.Get()) },
					OnPress: func(core.PressEvent) {
						if !parent.deleting {
							a.selectSession(parent)
						}
					},
					Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, MinWidth: core.Pt(0), FlexShrink: 1,
						MinHeight: core.Pt(26), CornerRadius: ui.RadiusControl},
					StyleFunc: func() core.Style { return core.Style{FocusVisible: ui.FocusRing(cx, 2)} }, Children: []core.Node{
						ui.Icon(lucide.CornerUpLeft, 12, colors.Muted),
						core.Text{ContentFunc: func() string { return apptext.T("父会话 · %s", parent.title.Get()) }, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{FontSize: 11.5, FlexShrink: 1, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Muted)},
					}},
				core.Text{ContentFunc: func() string { return apptext.T(sessionDelegationState(s)) }, Role: core.RoleStatus, TestID: "composer-subagent-status",
					Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Muted)},
			}},
			core.Show{When: func() bool { return subagentTask(s) != "" }, Then: func(*core.Scope) core.Node {
				return core.Text{ContentFunc: func() string { return subagentTask(s) }, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 11.5, MinWidth: core.Pt(0), FlexShrink: 1}, StyleFunc: ui.Colored(colors.Muted)}
			}},
		}}
	})
}

func subagentTask(s *session) string {
	turns := s.turns.Get()
	for i := len(turns) - 1; i >= 0; i-- {
		if !turns[i].System && turns[i].Prompt != "" {
			return viewkit.FirstLine(turns[i].Prompt, 120)
		}
	}
	return ""
}

func delegationTone(state string, colors ui.Colors) (func() *core.SVG, func() core.Color) {
	switch state {
	case "启动中", "运行中", "已转入后台":
		return lucide.LoaderCircle, colors.Info
	case "等待中", "待确认":
		return lucide.Clock, colors.Warn
	case "失败":
		return lucide.CircleAlert, colors.Danger
	case "已完成":
		return lucide.CircleCheck, colors.Up
	case "已停止":
		return lucide.CircleX, colors.Muted
	default:
		return lucide.Circle, colors.Muted
	}
}
