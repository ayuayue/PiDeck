//go:build !js && !android && !ios

package workbench

import (
	"strconv"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// activityPane collects waiting approvals and active work from the actual
// session state, so selecting an item returns to the conversation that owns it.
func (a *app) activityPane() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		items := a.activityItems()
		waiting, running := a.activityGroups()
		if len(items) == 0 {
			return core.View{Style: ui.FillRest.Merge(core.Style{AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 8}),
				Children: []core.Node{
					ui.Icon(lucide.CircleCheck, 24, colors.Faint),
					ui.Text(apptext.T("目前没有需要处理的对话"), 13, ui.Medium, colors.Text),
					ui.Text(apptext.T("等待确认或正在运行的会话会出现在这里。"), 11, ui.Regular, colors.Muted),
				}}
		}
		return core.View{TestID: "activity-list", Style: ui.FillRest.Merge(core.Style{Gap: 9}), Children: []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 12}, Children: []core.Node{
				core.Text{Content: apptext.T("需要确认 · %d", waiting), Style: core.Style{FontSize: 11, FontWeight: ui.Medium}, StyleFunc: ui.Colored(func() core.Color { return colors.Warn() })},
				core.Text{Content: apptext.T("正在运行 · %d", running), Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
				core.View{Style: core.Style{FlexGrow: 1}},
				ui.Text(apptext.T("最多显示 %d 个会话", activityLimit), 9.5, ui.Regular, colors.Faint),
			}},
			core.List{Style: ui.FillRest, Count: func() int { return len(items) }, EstimatedSize: 52,
				Key: func(i int) any { return items[i].session.ID },
				Row: func(cx *core.Scope, row core.ListRow) core.Node {
					i := row.Index()
					if i < 0 || i >= len(items) {
						return nil
					}
					return a.activityRow(items[i], ui.ColorsOf(cx))
				}},
		}}
	})
}

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
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10,
				MinHeight: core.Pt(42), Padding: core.Symmetric(7, 9), CornerRadius: 7,
				Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{
			ui.IconOf(icon, 14, func() core.Color {
				if item.waiting > 0 {
					return colors.Warn()
				}
				return colors.Accent()
			}),
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 2}, Children: []core.Node{
				core.Text{Content: s.title.Get(), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 12.5, FontWeight: ui.Medium}, StyleFunc: ui.Colored(colors.Text)},
				core.Text{Content: meta, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
			}},
			core.View{Style: core.Style{Padding: core.Symmetric(3, 7), CornerRadius: 9, Background: colors.Inset()},
				Children: []core.Node{ui.Text(label, 9, ui.Medium, colors.Muted)}},
		},
	}
}

func (a *app) activityShortcut() core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{
		OnPress: func(core.PressEvent) { a.openPane(paneActivity) },
		Role:    core.RoleButton, Label: apptext.T("活动"), TestID: "rail-activity",
		StyleFunc: func() core.Style {
			st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, Height: core.Pt(30), Padding: core.Symmetric(0, 8),
				CornerRadius: 7, Transition: viewkit.PressMotion,
				Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
			if a.paneVisible() && a.activePane.Get() == paneActivity {
				st.Background = colors.Pressed()
			}
			return st
		},
		Children: []core.Node{
			ui.Icon(lucide.Activity, 13.5, colors.Muted),
			ui.Text(apptext.T("活动"), 12.5, ui.Regular, colors.Text),
			core.View{Style: core.Style{FlexGrow: 1}},
			core.Show{When: func() bool { return a.activityCount() > 0 }, Then: func(cx *core.Scope) core.Node {
				c := ui.ColorsOf(cx)
				return core.View{TestID: "rail-activity-count", Style: core.Style{MinWidth: core.Pt(16), Height: core.Pt(16), Padding: core.Symmetric(0, 4),
					CornerRadius: 8, Background: c.Inset(), AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter},
					Children: []core.Node{core.Text{ContentFunc: func() string {
						n := a.activityCount()
						if n > 99 {
							return "99+"
						}
						return strconv.Itoa(n)
					}, Style: core.Style{FontSize: 9, FontWeight: ui.Medium}, StyleFunc: ui.Colored(c.Muted)}}}
			}},
		},
	}
}
