//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) managedSessionRow(cx *core.Scope, sess func() *session, agentName func(string) string) core.Node {
	m, colors := a.sessionManager, ui.ColorsOf(cx)
	s := sess()
	return core.View{TestID: "managed-session-row", StyleFunc: func() core.Style {
		st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10, MinHeight: core.Pt(58),
			Padding: core.Symmetric(8, 10), CornerRadius: 7, Hover: &core.Style{Background: colors.Hover()}}
		if m.selected.Get()[s.ID] {
			st.Background = colors.Pressed()
		}
		return st
	}, Children: []core.Node{
		ui.Checkbox{LabelFunc: func() string { return apptext.T("选择会话：%s", s.title.Get()) }, TestID: "managed-select-" + s.ID,
			Checked: func() bool { return m.selected.Get()[s.ID] }, Disabled: a.sessionManagerLocked,
			OnChange: func(on bool) { a.toggleManagedSession(s.ID, on) }},
		core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 4}, Children: []core.Node{
			core.Text{ContentFunc: s.title.Get, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FontSize: 13, LineHeight: 18, FontWeight: ui.Medium}, StyleFunc: ui.Colored(colors.Text)},
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
				core.Text{ContentFunc: func() string { return agentName(managedAgentKey(s)) }, MaxLines: 1,
					Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Muted)},
				core.Text{ContentFunc: func() string { return viewkit.WhenText(s.updated.Get(), a.clock.Get()) },
					Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)},
				core.Show{When: func() bool { return s.External }, Then: func(*core.Scope) core.Node {
					return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 3}, Children: []core.Node{
						ui.Icon(lucide.Lock, 10, colors.Faint), ui.Text(apptext.T("pi 原始会话"), 10.5, ui.Regular, colors.Faint),
					}}
				}},
			}},
		}},
		ui.Button{Text: apptext.T("打开"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "managed-open-" + s.ID,
			Disabled: a.sessionManagerLocked, OnPress: func() { a.closeSessionManager(); a.selectSession(s) }},
	}}
}
