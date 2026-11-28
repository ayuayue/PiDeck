//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// activityRow is one started session at work: waiting for an answer or
// still running. Picking it returns to the conversation that owns it.
func (a *app) activityRow(item activityItem, colors ui.Colors) core.Node {
	s := item.session
	label, icon, testID := apptext.T("正在运行"), lucide.Loader, "activity-running-"
	if item.waiting > 0 {
		label, icon, testID = apptext.T("需要确认"), lucide.BadgeQuestionMark, "activity-waiting-"
	}
	meta := projectLabel(s.WS)
	if !item.updated.IsZero() {
		meta += " · " + viewkit.WhenText(item.updated, a.cx.Now())
	}
	if item.waiting > 1 {
		meta += " · " + apptext.T("还有 %d 个问题", item.waiting-1)
	}
	return core.View{
		OnPress: func(core.PressEvent) { a.selectSession(s) },
		Role:    core.RoleButton, Label: label + " · " + s.title.Get(), TestID: testID + s.ID,
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8,
				MinHeight: core.Pt(44), Padding: core.Symmetric(8, 8), CornerRadius: 7,
				Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{
			ui.IconOf(icon, 14, func() core.Color {
				if item.waiting > 0 {
					return colors.Warn()
				}
				return viewkit.Working
			}),
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 2}, Children: []core.Node{
				core.Text{Content: s.title.Get(), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 13.5, LineHeight: 19, FontWeight: ui.Medium}, StyleFunc: ui.Colored(colors.Text)},
				core.Text{Content: meta, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 11, LineHeight: 15}, StyleFunc: ui.Colored(colors.Faint)},
			}},
			core.View{Style: core.Style{Padding: core.Symmetric(3, 7), CornerRadius: 9, Background: colors.Inset()},
				Children: []core.Node{ui.Text(label, 10, ui.Medium, colors.Muted)}},
		},
	}
}
