//go:build !js && !android && !ios

package workbench

// Renaming a project: a display name over its folder, kept in config.

import (
	"strings"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// askWorkspaceName opens the rename dialog for a project.
func (a *app) askWorkspaceName(w *workspace) {
	if w == nil || w.Chat {
		return
	}
	a.wsRenameKey.Set(w.Target.key() + "|" + w.Path)
	a.wsRenameText.Set(w.Name)
	a.wsRenameOpen.Set(true)
}

// saveWorkspaceName stores the name the dialog shows.
func (a *app) saveWorkspaceName() {
	key := a.wsRenameKey.GetUntracked()
	name := strings.TrimSpace(a.wsRenameText.GetUntracked())
	for _, w := range a.workspaces.GetUntracked() {
		if w.Target.key()+"|"+w.Path != key {
			continue
		}
		w.Name = name
		a.saveProjects()
		break
	}
	a.wsRenameOpen.Set(false)
}

// workspaceRenameDialog edits a project's display name.
func (a *app) workspaceRenameDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return ui.Dialog{
			Open:         a.wsRenameOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.wsRenameOpen.Set(open) },
			Title:        apptext.T("重命名项目"),
			TestID:       "ws-rename",
			Style:        core.Style{Width: core.Pt(420)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 10}, Children: []core.Node{
				core.Text{Content: apptext.T("给项目起一个显示名；留空就用文件夹名。"), Style: core.Style{FontSize: 11.5},
					StyleFunc: ui.Colored(colors.Muted)},
				core.Input{Value: a.wsRenameText.Get, OnChange: a.wsRenameText.Set, Placeholder: apptext.T("项目名称"),
					Label: apptext.T("项目名称"), TestID: "ws-rename-input", AutoFocus: true,
					OnSubmit: func(string) { a.saveWorkspaceName() },
					Style: core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 9), CornerRadius: 7,
						Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(),
						Color: colors.Text(), FontSize: 12.5}},
			}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.wsRenameOpen.Set(false) }},
				ui.Button{Text: apptext.T("保存"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "ws-rename-save",
					OnPress: func() { a.saveWorkspaceName() }},
			},
		}
	})
}
