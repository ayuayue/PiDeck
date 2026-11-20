//go:build !js && !android && !ios

package workbench

import (
	"maps"

	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) projectRemoveDialog() core.Node {
	return core.Show{When: a.projectRemoveOpen.Get, Then: func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		selected := core.NewSignalFunc(cx, map[string]bool{}, nil)
		projects := core.NewMemoFunc(cx, func() []*workspace {
			var list []*workspace
			for _, ws := range a.workspaces.Get() {
				if !ws.Chat {
					list = append(list, ws)
				}
			}
			return list
		}, nil)
		return ui.Dialog{Title: apptext.T("批量移除项目"), TestID: "project-remove-dialog", Open: a.projectRemoveOpen.Get,
			OnOpenChange: func(on bool, _ base.Reason) { a.projectRemoveOpen.Set(on) }, Style: core.Style{Width: a.dialogWidth()},
			Children: []core.Node{
				ui.Text(apptext.T("选中的项目会从侧栏移除，项目文件和会话仍保留。"), 12, ui.Regular, colors.Muted),
				core.List{Style: core.Style{Height: core.Pt(260)}, Count: func() int { return len(projects.Get()) }, EstimatedSize: 34,
					Key: func(i int) any { return trustKey(projects.Get()[i]) },
					Row: func(cx *core.Scope, row core.ListRow) core.Node {
						return core.Dynamic(func(cx *core.Scope) core.Node {
							list, i := projects.Get(), row.Index()
							if i < 0 || i >= len(list) {
								return nil
							}
							ws := list[i]
							key := trustKey(ws)
							return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Symmetric(4, 6)}, Children: []core.Node{
								ui.Checkbox{Checked: func() bool { return selected.Get()[key] }, Label: ws.label(), TestID: "project-remove-choice",
									OnChange: func(on bool) {
										next := maps.Clone(selected.GetUntracked())
										if on {
											next[key] = true
										} else {
											delete(next, key)
										}
										selected.Set(next)
									}},
								core.Text{Content: ws.Path, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
									Style: core.Style{FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
							}}
						})
					}},
			}, Footer: []core.Node{
				ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, OnPress: func() { a.projectRemoveOpen.Set(false) }},
				ui.Button{Text: apptext.T("移除所选"), TestID: "project-remove-submit", Disabled: func() bool { return len(selected.Get()) == 0 }, OnPress: func() {
					a.removeWorkspacesNow(selected.GetUntracked())
					a.projectRemoveOpen.Set(false)
				}},
			}}
	}}
}
