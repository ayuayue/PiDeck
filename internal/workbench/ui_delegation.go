//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"slices"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) delegationOverview(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		entries := delegations(s.turns.Get(), s.liveTools.Get())
		if len(entries) == 0 {
			return nil
		}
		colors := ui.ColorsOf(cx)
		children := []core.Node{core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
			ui.Icon(lucide.Bot, 14, colors.Accent),
			ui.Text(apptext.T("子代理与工作流"), 12, ui.Semibold, colors.Text),
			ui.Text(fmt.Sprint(len(entries)), 11, ui.Regular, colors.Muted),
			ui.Button{Text: apptext.T("查看全部"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "delegate-show-all", OnPress: func() { a.delegationSession.Set(s) }},
		}}}
		// The drawer shows recent activity. The original tool rows stay in the transcript.
		for i := len(entries) - 1; i >= max(0, len(entries)-8); i-- {
			d := entries[i]
			ink := colors.Muted
			if d.state == "失败" {
				ink = colors.Danger
			} else if d.state == "运行中" {
				ink = colors.Info
			}
			children = append(children, core.View{TestID: "delegate-run-" + d.CallID,
				Style: core.Style{Gap: 4, Padding: core.Symmetric(6, 8), Background: colors.Inset(), CornerRadius: ui.RadiusControl},
				Children: []core.Node{
					ui.Text(apptext.T(d.Action)+" · "+apptext.T(d.state), 11, ui.Medium, ink),
					core.Text{Content: firstNonEmpty(d.Detail, d.Name), MaxLines: 2, Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Text)},
					ui.Button{Text: apptext.T("在对话中查看"), Size: ui.SizeSmall, Variant: ui.ButtonGhost,
						TestID: "delegate-open-" + d.CallID, OnPress: func() {
							idx := slices.IndexFunc(s.turns.GetUntracked(), func(t turn) bool { return t.ID == d.turnID })
							a.jumpToTurnIndex(s, idx)
						}},
				}})
		}
		return core.View{Style: core.Style{Gap: 4}, Children: children}
	})
}

// Keep the full history virtualized. It projects original tool records and
// completion notices; opening the view never starts or resumes an agent.
func (a *app) delegationDialog() core.Node {
	return core.Show{When: func() bool { return a.delegationSession.Get() != nil }, Then: func(cx *core.Scope) core.Node {
		s := a.delegationSession.GetUntracked()
		colors := ui.ColorsOf(cx)
		entries := core.NewMemoFunc(cx, func() []delegation {
			list := delegations(s.turns.Get(), s.liveTools.Get())
			slices.Reverse(list)
			return list
		}, nil)
		return ui.Dialog{Title: apptext.T("子代理与工作流"), TestID: "delegate-history", Open: func() bool { return a.delegationSession.Get() == s },
			OnOpenChange: func(on bool, _ base.Reason) {
				if !on {
					a.delegationSession.Set(nil)
				}
			},
			Style: core.Style{Width: a.dialogWidth()}, Children: []core.Node{
				ui.Text(apptext.T("从工具记录与完成通知读取；后台派发回执不代表任务已完成。"), 11, ui.Regular, colors.Muted),
				core.List{TestID: "delegate-history-list", Style: core.Style{Height: core.Pt(420)}, EstimatedSize: 140, Gap: 10,
					Count: func() int { return len(entries.Get()) }, Key: func(i int) any { return entries.Get()[i].CallID },
					Empty: ui.Text(apptext.T("没有可识别的子代理或工作流记录。"), 12, ui.Regular, colors.Muted),
					Row: func(cx *core.Scope, row core.ListRow) core.Node {
						return core.Dynamic(func(cx *core.Scope) core.Node {
							list, i := entries.Get(), row.Index()
							if i < 0 || i >= len(list) {
								return nil
							}
							d := list[i]
							var nested []core.Node
							for _, step := range d.Nested[:min(len(d.Nested), 8)] {
								nested = append(nested, core.Text{Content: step, MaxLines: 2, Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)})
							}
							return core.View{TestID: "delegate-history-" + d.CallID, Style: core.Style{Gap: 6, Padding: core.Symmetric(8, 4), Borders: core.Edges{Bottom: 1}, BorderColors: core.EdgeColors{Bottom: colors.Line()}}, Children: []core.Node{
								ui.Text(apptext.T(d.Action)+" · "+apptext.T(d.state), 12, ui.Semibold, colors.Text),
								core.Text{Content: firstNonEmpty(d.Detail, d.Name), MaxLines: 3, Selectable: core.SelectableOn, Style: core.Style{FontSize: 12}, StyleFunc: ui.Colored(colors.Text)},
								core.View{Style: core.Style{Gap: 3}, Children: nested},
								core.Text{Content: shorten(d.Output, 16000), MaxLines: 12, Selectable: core.SelectableOn, Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
								ui.Button{Text: apptext.T("在对话中查看"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "delegate-history-open-" + d.CallID, OnPress: func() {
									a.delegationSession.Set(nil)
									if a.byID[s.ID] == s && !s.deleting {
										a.selectSession(s)
										a.jumpToTurnIndex(s, slices.IndexFunc(s.turns.GetUntracked(), func(t turn) bool { return t.ID == d.turnID }))
									}
								}},
							}}
						})
					}},
			}, Footer: []core.Node{ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, OnPress: func() { a.delegationSession.Set(nil) }}}}
	}}
}
