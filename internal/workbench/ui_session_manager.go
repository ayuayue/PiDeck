//go:build !js && !android && !ios

package workbench

import (
	"context"
	"sort"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) sessionManagerDialog() core.Node {
	m := a.sessionManager
	return core.Dynamic(func(cx *core.Scope) core.Node {
		a.langRev.Get()
		return ui.Dialog{
			Open: m.open.Get,
			OnOpenChange: func(open bool, _ base.Reason) {
				if !open {
					a.closeSessionManager()
				}
			},
			Title: apptext.T("会话管理"), TestID: "session-manager",
			Style: core.Style{Width: core.Pct(84), MaxWidth: core.Pt(840), Height: core.Pt(640), MaxHeight: core.Pct(90)},
			Children: []core.Node{core.Show{When: m.open.Get, Then: func(cx *core.Scope) core.Node {
				names := core.NewResource(cx, nil, func(context.Context, struct{}, core.ResourceInfo) (map[string]string, error) {
					out := map[string]string{"pi": "pi", "acp:": "ACP"}
					for _, preset := range acpPresets() {
						out["acp:"+preset.ID] = preset.Name
					}
					return out, nil
				})
				name := func(key string) string {
					if labels, ok := names.Get(); ok && labels[key] != "" {
						return labels[key]
					}
					return firstNonEmpty(strings.TrimPrefix(key, "acp:"), "ACP")
				}
				return a.sessionManagerContent(cx, name)
			}}},
			Footer: []core.Node{ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, TestID: "session-manager-close",
				Disabled: m.busy.Get, OnPress: a.closeSessionManager}},
		}
	})
}

func (a *app) sessionManagerLocked() bool {
	return a.sessionManager.busy.Get() || a.sessionManager.confirm.Get()
}

func (a *app) sessionManagerContent(cx *core.Scope, agentName func(string) string) core.Node {
	m, colors := a.sessionManager, ui.ColorsOf(cx)
	return core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), Gap: 10}, Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
			ui.Select[string]{Label: apptext.T("项目"), TestID: "session-manager-project", Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(160)},
				OptionsFunc: func() []ui.Option[string] {
					var out []ui.Option[string]
					for _, ws := range a.workspaces.Get() {
						out = append(out, ui.Option[string]{Value: ws.key(), Label: ws.label()})
					}
					return out
				},
				Value: func() string {
					if ws := m.workspace.Get(); ws != nil {
						return ws.key()
					}
					return ""
				},
				OnChange: func(key string) {
					if !a.sessionManagerLocked() {
						m.workspace.Set(a.workspaceByWireKey(key))
						a.resetSessionManagerSelection()
						a.refreshManagedSessions()
					}
				}, Disabled: a.sessionManagerLocked},
			core.Dynamic(func(*core.Scope) core.Node {
				archived := m.archived.Get()
				activeVariant, archiveVariant := ui.ButtonSecondary, ui.ButtonGhost
				if archived {
					activeVariant, archiveVariant = archiveVariant, activeVariant
				}
				return core.View{Style: core.Style{Direction: core.Row, Gap: 2}, Children: []core.Node{
					ui.Button{Text: apptext.T("未归档"), Variant: activeVariant, TestID: "session-manager-show-active",
						Disabled: a.sessionManagerLocked, OnPress: func() { a.setSessionManagerArchived(false) }},
					ui.Button{Text: apptext.T("已归档"), Icon: lucide.Archive, Variant: archiveVariant, TestID: "session-manager-show-archived",
						Disabled: a.sessionManagerLocked, OnPress: func() { a.setSessionManagerArchived(true) }},
				}}
			}),
			ui.IconButton{Icon: lucide.RefreshCw, Label: apptext.T("刷新会话"), TestID: "session-manager-refresh",
				Disabled: func() bool {
					ws := m.workspace.Get()
					return a.sessionManagerLocked() || (ws != nil && ws.PiLoading.Get())
				}, OnPress: a.refreshManagedSessions},
		}},
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
			core.Input{Value: m.query.Get, OnChange: a.setSessionManagerQuery, Role: core.RoleSearchField,
				Label: apptext.T("搜索会话"), Placeholder: apptext.T("搜索会话名称或 ID…"), TestID: "session-manager-query", AutoFocus: true,
				Disabled: a.sessionManagerLocked,
				StyleFunc: func() core.Style {
					return panelFieldStyle(colors).Merge(core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(180)})
				}},
			ui.Select[string]{Value: m.agent.Get, OnChange: a.setSessionManagerAgent, Label: apptext.T("筛选 Agent"),
				TestID: "session-manager-agent", Disabled: a.sessionManagerLocked, Style: core.Style{Width: core.Pt(176)},
				OptionsFunc: func() []ui.Option[string] {
					keys := map[string]bool{}
					for _, s := range managedProjectSessions(m.workspace.Get()) {
						keys[managedAgentKey(s)] = true
					}
					ordered := make([]string, 0, len(keys))
					for key := range keys {
						ordered = append(ordered, key)
					}
					sort.Strings(ordered)
					out := []ui.Option[string]{{Value: "", Label: apptext.T("全部 Agent")}}
					for _, key := range ordered {
						out = append(out, ui.Option[string]{Value: key, Label: agentName(key)})
					}
					return out
				}},
		}},
		core.Dynamic(func(cx *core.Scope) core.Node { return a.sessionManagerList(cx, agentName) }),
		core.Dynamic(func(cx *core.Scope) core.Node { return a.sessionManagerActions(cx) }),
	}}
}

func (a *app) sessionManagerList(cx *core.Scope, agentName func(string) string) core.Node {
	m, colors := a.sessionManager, ui.ColorsOf(cx)
	rows := a.managedSessions()
	pageRows, page, pages := managedSessionPage(rows, m.page.Get())
	var body core.Node
	if ws := m.workspace.Get(); ws != nil && ws.PiLoading.Get() {
		body = core.View{TestID: "session-manager-loading", Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 8},
			Children: []core.Node{ui.Spinner{Size: 18}, ui.Text(apptext.T("正在读取历史会话"), 12, ui.Regular, colors.Muted)}}
	} else if len(rows) == 0 {
		text := apptext.T("没有匹配的会话")
		if m.query.Get() == "" && m.agent.Get() == "" {
			text = apptext.T("这个项目还没有会话")
			if m.archived.Get() {
				text = apptext.T("这个项目还没有归档会话")
			}
		}
		body = core.View{TestID: "session-manager-empty", Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 8},
			Children: []core.Node{ui.Icon(lucide.MessagesSquare, 24, colors.Faint), ui.Text(text, 12.5, ui.Regular, colors.Muted)}}
	} else {
		body = core.Scroll{TestID: "session-manager-list", Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0)}, Children: []core.Node{
			core.Each(func() []*session { return pageRows }, func(s *session) string { return s.ID },
				func(cx *core.Scope, s func() *session, _ func() int) core.Node {
					return a.managedSessionRow(cx, s, agentName)
				}),
		}}
	}
	return core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), Gap: 6}, Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Symmetric(0, 8)}, Children: []core.Node{
			ui.Checkbox{Text: apptext.T("选择本页"), TestID: "session-manager-select-page", Disabled: func() bool { return a.sessionManagerLocked() || len(pageRows) == 0 },
				Checked: func() bool {
					selected := m.selected.Get()
					for _, s := range pageRows {
						if !selected[s.ID] {
							return false
						}
					}
					return len(pageRows) > 0
				},
				Indeterminate: func() bool {
					count := 0
					for _, s := range pageRows {
						if m.selected.Get()[s.ID] {
							count++
						}
					}
					return count > 0 && count < len(pageRows)
				}, OnChange: a.selectManagedPage},
			core.View{Style: core.Style{FlexGrow: 1}},
			ui.Text(apptext.T("共 %d 个会话", len(rows)), 11.5, ui.Regular, colors.Muted),
		}},
		body,
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, JustifyContent: core.JustifySpaceBetween, Wrap: core.Wrap, Gap: 6}, Children: []core.Node{
			ui.Text(apptext.T("第 %d / %d 页 · 每页 %d 条", page, pages, sessionManagerPageSize), 11, ui.Regular, colors.Faint),
			ui.Pagination{Page: func() int { return page }, TotalPages: func() int { return pages }, VisiblePages: 3,
				Compact: func() bool { return true }, Disabled: a.sessionManagerLocked,
				Label: apptext.T("会话分页"), PreviousLabel: apptext.T("上一页"), NextLabel: apptext.T("下一页"), TestID: "session-manager-pages",
				OnChange: func(next int) { m.page.Set(next) }},
		}},
	}}
}

func (a *app) sessionManagerActions(cx *core.Scope) core.Node {
	m, colors := a.sessionManager, ui.ColorsOf(cx)
	picked := a.pickedManagedSessions()
	locked := a.sessionManagerLocked
	if m.confirm.Get() {
		return core.View{TestID: "session-manager-delete-confirm", StyleFunc: func() core.Style {
			return core.Style{Gap: 8, Padding: core.All(12), CornerRadius: 8, Background: colors.Inset(), BorderWidth: 1, BorderColor: colors.Danger()}
		}, Children: []core.Node{
			ui.Text(apptext.T("删除选中的 %d 个会话？", len(m.pending)), 13, ui.Semibold, colors.Text),
			core.Text{Content: apptext.T("将停止这些会话的 Agent，并将文件移入所在设备的数据目录的 trash。"),
				Style: core.Style{FontSize: 12, LineHeight: 18}, StyleFunc: ui.Colored(colors.Muted)},
			core.View{Style: core.Style{Direction: core.Row, JustifyContent: core.JustifyEnd, Gap: 8}, Children: []core.Node{
				ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, TestID: "session-manager-delete-cancel",
					OnPress: func() { m.confirm.Set(false); m.pending = nil }},
				ui.Button{Text: apptext.T("确认删除"), Variant: ui.ButtonDanger, TestID: "session-manager-delete-ok", OnPress: a.deleteManagedSessions},
			}},
		}}
	}
	archiveText, archiveID, archiveIcon := apptext.T("归档"), "session-manager-archive", lucide.Archive
	if m.archived.Get() {
		archiveText, archiveID, archiveIcon = apptext.T("还原"), "session-manager-restore", lucide.ArchiveRestore
	}
	var note core.Node = core.Text{ContentFunc: m.message.Get, MaxLines: 2, Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Muted)}
	for _, s := range picked {
		if s.External {
			note = ui.Text(apptext.T("pi 原始会话可以归档，但不能在应用中删除。"), 11, ui.Regular, colors.Muted)
			break
		}
	}
	return core.View{Style: core.Style{Gap: 6, BorderWidth: 1, BorderColor: colors.Border(), Padding: core.All(10), CornerRadius: 8}, Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
			ui.Text(apptext.T("已选 %d 个会话", len(picked)), 12, ui.Medium, colors.Text),
			ui.Button{Text: apptext.T("清空选择"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "session-manager-clear",
				Disabled: func() bool { return locked() || len(picked) == 0 }, OnPress: func() { m.selected.Set(map[string]bool{}) }},
			core.View{Style: core.Style{FlexGrow: 1}},
			ui.Button{Text: archiveText, Icon: archiveIcon, Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: archiveID,
				Disabled: func() bool { return locked() || len(picked) == 0 }, OnPress: func() { a.archiveManagedSessions(!m.archived.GetUntracked()) }},
			ui.Button{Text: apptext.T("删除"), Icon: lucide.Trash, Variant: ui.ButtonDanger, Size: ui.SizeSmall,
				TestID: "session-manager-delete", Disabled: func() bool { return locked() || !a.canDeleteManagedSessions() }, OnPress: a.askDeleteManagedSessions},
		}},
		note,
	}}
}
