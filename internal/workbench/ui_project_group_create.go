//go:build !js && !android && !ios

package workbench

import (
	"maps"
	"path/filepath"
	"slices"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) projectGroupCreateDialog(open *core.Signal[bool]) core.Node {
	return core.Show{When: open.Get, Then: func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		name := core.NewSignal(cx, "")
		selected := core.NewSignalFunc(cx, map[string]bool{}, nil)
		var initial []projectGroupDirectory
		for _, ws := range a.workspaces.GetUntracked() {
			if ws != nil && !ws.Chat {
				initial = append(initial, projectGroupDirectory{target: ws.Target, path: ws.Path, label: ws.label()})
			}
		}
		directories := core.NewSignalFunc(cx, initial, nil)
		addDirectories := func() {
			cx.PickDirectories(core.PickDirectoriesOptions{Multiple: true}, func(dirs []core.Directory, err error) {
				if err != nil {
					a.toast(ui.ToastError, "选择文件夹失败", err.Error())
					return
				}
				list := slices.Clone(directories.GetUntracked())
				next := maps.Clone(selected.GetUntracked())
				seen := make(map[string]bool, len(list))
				for _, d := range list {
					seen[d.key()] = true
				}
				for _, dir := range dirs {
					path := cleanTargetPath(localTarget, dir.Path)
					if path == "" {
						continue
					}
					if ws := a.workspaceFor(localTarget, path); ws != nil && ws.Chat {
						continue
					}
					d := projectGroupDirectory{target: localTarget, path: path, label: filepath.Base(path)}
					if !seen[d.key()] {
						list = append(list, d)
						seen[d.key()] = true
					}
					next[d.key()] = true
				}
				cx.Batch(func() {
					directories.Set(list)
					selected.Set(next)
				})
			})
		}
		save := func() {
			var chosen []projectGroupDirectory
			for _, d := range directories.GetUntracked() {
				if selected.GetUntracked()[d.key()] {
					chosen = append(chosen, d)
				}
			}
			if strings.TrimSpace(name.GetUntracked()) == "" || len(chosen) == 0 {
				return
			}
			a.cx.Batch(func() {
				open.Set(false)
				a.createProjectGroup(name.GetUntracked(), chosen)
			})
		}
		return ui.Dialog{Title: apptext.T("新建分组项目"), TestID: "project-group-create", Open: open.Get,
			OnOpenChange: func(on bool, _ base.Reason) { open.Set(on) }, Style: core.Style{Width: a.dialogWidth()},
			Children: []core.Node{
				ui.Text(apptext.T("选择已有项目，或添加多个目录；会话仍保留在原目录。"), 12, ui.Regular, colors.Muted),
				core.Input{Value: name.Get, OnChange: name.Set, Placeholder: apptext.T("分组名"), Label: apptext.T("分组名"),
					TestID: "project-group-create-name", AutoFocus: true, OnSubmit: func(string) { save() },
					Style: core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 9), CornerRadius: 7,
						Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), Color: colors.Text(), FontSize: 12.5}},
				core.List{TestID: "project-group-create-list", Style: core.Style{Height: core.Pt(260), Padding: core.Edges{Right: viewkit.PanelInset}}, Count: func() int { return len(directories.Get()) }, EstimatedSize: 44,
					Key: func(i int) any { return directories.Get()[i].key() },
					Row: func(cx *core.Scope, row core.ListRow) core.Node {
						return core.Dynamic(func(cx *core.Scope) core.Node {
							list, i := directories.Get(), row.Index()
							if i < 0 || i >= len(list) {
								return nil
							}
							d := list[i]
							path := d.path
							if d.target.remote() {
								path = d.target.label() + " · " + path
							}
							return core.View{Style: core.Style{Gap: 2, Padding: core.Symmetric(4, 6)}, Children: []core.Node{
								ui.Checkbox{Checked: func() bool { return selected.Get()[d.key()] }, Label: d.label,
									TestID: "project-group-choice-" + d.key(), OnChange: func(on bool) {
										next := maps.Clone(selected.GetUntracked())
										if on {
											next[d.key()] = true
										} else {
											delete(next, d.key())
										}
										selected.Set(next)
									}},
								core.Text{Content: path, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
									Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
							}}
						})
					}},
				ui.Button{Text: apptext.T("添加目录…"), Icon: lucide.FolderPlus, Variant: ui.ButtonGhost,
					TestID: "project-group-add-directories", OnPress: addDirectories},
			}, Footer: []core.Node{
				ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, TestID: "project-group-create-cancel", OnPress: func() { open.Set(false) }},
				ui.Button{Text: apptext.T("创建分组"), Variant: ui.ButtonPrimary, TestID: "project-group-create-save", OnPress: save,
					Disabled: func() bool { return strings.TrimSpace(name.Get()) == "" || len(selected.Get()) == 0 }},
			}}
	}}
}

// projectGroupHeading lets the user undo a group without removing its projects.
func (a *app) projectGroupHeading(g projectGroup) core.Node {
	if !g.Named {
		return a.groupLabel(g.Name)
	}
	colors := ui.ColorsOf(a.cx)
	actions := func() []core.Node {
		return []core.Node{ui.MenuItem{Text: apptext.T("撤销分组"), Icon: lucide.FolderMinus, TestID: "project-group-dissolve",
			OnSelect: func() { a.dissolveProjectGroup(g.Name) }}}
	}
	return base.ContextMenu{PopupStyleFunc: func() core.Style { return a.menuCard(a.cx) }, Children: actions(),
		Trigger: core.View{TestID: "project-group-heading", Label: g.Name,
			Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Padding: core.Edges{Top: 8, Right: 4, Left: 8}},
			Children: []core.Node{
				core.Text{Content: g.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11, FontWeight: ui.Medium}, StyleFunc: ui.Colored(colors.Faint)},
				ui.Menu{Trigger: ui.Button{Icon: lucide.Ellipsis, Label: apptext.T("更多项目操作"), Variant: ui.ButtonGhost,
					Size: ui.SizeSmall, Side: 20, IconSize: 12, Tint: func() core.Color { return colors.Faint() }},
					TestID: "project-group-menu-" + g.Name, Placement: core.PlaceBottom, Align: core.AlignEnd, Children: actions()},
			}}}
}
