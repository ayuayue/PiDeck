package client

import (
	"fmt"
	"reflect"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/remotewire"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

func sameSessionActivity(a, b remotewire.SessionActivity) bool { return reflect.DeepEqual(a, b) }

func activityStateLabel(state string) string {
	switch state {
	case "starting":
		return apptext.T("启动中")
	case "running":
		return apptext.T("运行中")
	case "waiting":
		return apptext.T("等待中")
	case "approval":
		return apptext.T("待确认")
	case "background":
		return apptext.T("已转入后台")
	case "completed":
		return apptext.T("已完成")
	case "failed":
		return apptext.T("失败")
	case "stopped":
		return apptext.T("已停止")
	case "empty":
		return apptext.T("无结果")
	}
	return apptext.T("就绪")
}

func activityRunning(state string) bool {
	return state == "starting" || state == "running" || state == "waiting" || state == "approval" || state == "background"
}

type mobileActivityRow struct {
	id, name, state string
	sessionID       string
	turn            int
}

func activityRows(activity remotewire.SessionActivity) []mobileActivityRow {
	rows := make([]mobileActivityRow, 0, len(activity.Children)+len(activity.Delegations))
	for _, child := range activity.Children {
		rows = append(rows, mobileActivityRow{id: "session:" + child.ID, name: child.Title, state: child.State, sessionID: child.ID})
	}
	for _, entry := range activity.Delegations {
		rows = append(rows, mobileActivityRow{id: "tool:" + entry.ID, name: entry.Name, state: entry.State, turn: entry.Turn})
	}
	return rows
}

func (a *mobileApp) sessionActivityBar(cx *core.Scope) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		activity := a.features.activity.Get()
		colors := ui.ColorsOf(cx)
		var children []core.Node
		if parent := activity.Parent; parent != nil && parent.ID != "" {
			children = append(children, ui.Button{Text: apptext.T("父会话 · %s", parent.Title), Variant: ui.ButtonGhost,
				Size: ui.SizeSmall, TestID: "mobile-subagent-parent", OnPress: func() { a.openSession(parent.ID, parent.Title) }})
		}
		rows := activityRows(activity)
		if len(rows) > 0 {
			active := 0
			for _, row := range rows {
				if activityRunning(row.state) {
					active++
				}
			}
			children = append(children, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				ui.Icon(lucide.Bot, 12, colors.Muted),
				core.Text{Content: apptext.T("子代理与工作流"), Style: core.Style{FontSize: 11, FlexGrow: 1}, StyleFunc: ui.Colored(colors.Muted)},
				ui.Text(apptext.T("%d 进行中", active), 10.5, ui.Regular, colors.Muted),
				ui.Button{Text: apptext.T("查看全部"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "mobile-subagents-all", OnPress: func() {
					a.features.activityLimit.Set(40)
					a.features.activityOpen.Set(true)
				}},
			}})
			// Running tasks stay visible; completed history remains available in
			// the sheet without pushing the conversation off a narrow screen.
			shown := 0
			for _, row := range rows {
				if activityRunning(row.state) && shown < 2 {
					children = append(children, a.sessionActivityRow(cx, row, "mobile-subagent:"))
					shown++
				}
			}
			if shown == 0 {
				children = append(children, a.sessionActivityRow(cx, rows[len(rows)-1], "mobile-subagent:"))
			}
		}
		if len(children) == 0 {
			return nil
		}
		return core.View{TestID: "mobile-subagents", Style: core.Style{Gap: 2, Padding: core.Symmetric(2, 4)}, Children: children}
	})
}

func (a *mobileApp) sessionActivityRow(cx *core.Scope, row mobileActivityRow, prefix string) core.Node {
	colors := ui.ColorsOf(cx)
	tone := colors.Muted
	switch row.state {
	case "failed":
		tone = colors.Danger
	case "waiting", "approval":
		tone = colors.Warn
	case "running", "starting", "background":
		tone = colors.Info
	case "completed":
		tone = colors.Up
	}
	return base.Button{TestID: prefix + row.id, Label: row.name + " · " + activityStateLabel(row.state),
		OnPress: func(core.PressEvent) {
			a.features.activityOpen.Set(false)
			if row.sessionID != "" {
				a.openSession(row.sessionID, row.name)
				return
			}
			a.findOpen.Set(false)
			a.transcriptErr.Set("")
			a.features.jumpTurn.Set(row.turn)
		},
		Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinHeight: core.Pt(30), Padding: core.Symmetric(2, 4)},
		Children: []core.Node{
			core.Text{Content: row.name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FontSize: 11.5, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Text)},
			core.Text{Content: activityStateLabel(row.state), Role: core.RoleStatus, Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(tone)},
		}}
}

func (a *mobileApp) sessionActivitySheet(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return base.Sheet{Open: a.features.activityOpen.Get, OnOpenChange: func(open bool, _ base.Reason) { a.features.activityOpen.Set(open) },
		Side: core.PlaceBottom, Label: apptext.T("子代理与工作流"), TestID: "mobile-subagents-sheet",
		BackdropStyle: core.Style{Background: ui.Black(0.32)},
		PopupStyleFunc: func() core.Style {
			return core.Style{Width: core.Pct(100), MaxHeight: core.Pct(75), Padding: core.All(12), Gap: 6,
				PaddingEnv: core.EnvAll(core.EnvSafeArea), Background: colors.Surface()}
		}, Children: []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
				core.Text{Content: apptext.T("子代理与工作流"), Style: core.Style{FlexGrow: 1, FontSize: 14, FontWeight: ui.Medium}, StyleFunc: ui.Colored(colors.Text)},
				a.pressIcon(lucide.X, apptext.T("关闭"), 32, 14, nil, func() { a.features.activityOpen.Set(false) }, "mobile-subagents-close"),
			}},
			core.Scroll{Style: core.Style{FlexShrink: 1, MinHeight: core.Pt(0)}, Children: []core.Node{
				core.Dynamic(func(cx *core.Scope) core.Node {
					rows := activityRows(a.features.activity.Get())
					limit := min(len(rows), a.features.activityLimit.Get())
					var items []core.Node
					for _, row := range rows[:limit] {
						items = append(items, a.sessionActivityRow(cx, row, "mobile-subagent-all:"))
					}
					if len(rows) > limit {
						items = append(items, ui.Button{Text: apptext.T("加载更多"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
							TestID: "mobile-subagents-more", OnPress: func() { a.features.activityLimit.Update(func(n int) int { return n + 40 }) }})
					}
					return core.View{Style: core.Style{Gap: 2, Padding: core.Edges{Right: viewkit.PanelInset}}, Children: items}
				}),
			}},
		}}
}

func (a *mobileApp) watchSessionActivity(cx *core.Scope) {
	cx.Effect(func() {
		turn := a.features.jumpTurn.Get()
		if turn < 0 {
			return
		}
		messages := a.messages.Get()
		if a.transcriptErr.Get() != "" {
			a.features.jumpTurn.Set(-1)
			return
		}
		live := -1
		if a.running.Get() && len(messages) > 0 {
			live = messages[len(messages)-1].Turn
		}
		for i, row := range transcriptRows(messages, false, live) {
			if row.turn != turn {
				continue
			}
			a.features.jumpTurn.Set(-1)
			key := fmt.Sprintf("turn/%d", turn)
			if !hasKey(a.procOpen.GetUntracked(), key) {
				a.procOpen.Set(append(append([]string(nil), a.procOpen.GetUntracked()...), key))
			}
			id, visit := a.active.GetUntracked(), a.sessionSeq
			cx.Post(func() {
				if a.active.GetUntracked() == id && a.sessionSeq == visit {
					a.scroll.ScrollToIndexAt(i, 0.12, 0, false)
				}
			})
			return
		}
		if a.messagesBefore.Get() > 0 {
			if !a.olderBusy.Get() {
				a.loadOlderTranscript()
			}
		} else {
			a.features.jumpTurn.Set(-1)
		}
	})
}
