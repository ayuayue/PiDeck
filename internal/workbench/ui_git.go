//go:build !js && !android && !ios

package workbench

// The Git drawer: the branch and its upstream, changed files with their
// stage, unstage and discard actions, the commit box, the history and the
// patch dialog. The repository is read by git.go; this file only draws it
// and sends the user's actions back.

import (
	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// drawerGit draws the repository in the right drawer.
func (a *app) drawerGit() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		st := a.git.state.Get()
		if a.gitPath() == "" {
			return gitEmpty(colors, apptext.T("先打开一个项目"), apptext.T("Git 面板显示当前项目的分支、改动与历史。"))
		}
		if !st.Checked && st.Loading {
			return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 8},
				Children: []core.Node{ui.Spinner{Size: 16, Label: apptext.T("读取 Git 仓库")}, ui.Text(apptext.T("正在读取仓库…"), 12, ui.Regular, colors.Muted)}}
		}
		if st.NotRepo {
			return a.gitNotRepo(cx, st)
		}
		if !st.IsRepo && st.Error != "" {
			return core.View{Style: core.Style{Gap: 10, Padding: core.All(16)}, Children: []core.Node{
				ui.Text(apptext.T("无法读取 Git 仓库"), 13, ui.Semibold, colors.Danger),
				core.Text{Content: st.Error, Style: core.Style{FontSize: 11.5, LineHeight: 17}, StyleFunc: ui.Colored(colors.Muted)},
				ui.Button{Text: apptext.T("重试"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() { a.git.refreshAll() }},
			}}
		}
		return core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), MinWidth: core.Pt(0), Gap: 10}, Children: []core.Node{
			a.gitHeader(cx, st),
			core.Show{When: func() bool { return st.Error != "" }, Then: func(cx *core.Scope) core.Node {
				return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					ui.Icon(lucide.TriangleAlert, 12, colors.Danger),
					core.Text{Content: st.Error, MaxLines: 3, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 10.5, LineHeight: 15},
						StyleFunc: ui.Colored(colors.Danger)},
					ui.Button{Text: apptext.T("重试"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.git.refreshAll() }},
				}}
			}},
			core.Show{When: func() bool { return a.git.err.Get() != "" }, Then: func(cx *core.Scope) core.Node { return a.gitError(cx) }},
			core.Scroll{Style: ui.FillRest, Children: []core.Node{
				core.View{Style: core.Style{Gap: 12, Padding: core.Edges{Top: 2, Bottom: 20, Right: 2, Left: 2}}, Children: []core.Node{
					a.gitChanges(cx, st),
					a.gitCommitBox(cx, st),
					a.gitHistory(cx, st),
					core.Text{ContentFunc: func() string {
						if st.Root == "" {
							return shortPath(a.gitPath(), 48)
						}
						return shortPath(st.Root, 48)
					}, MaxLines: 2, EllipsizeMode: core.EllipsizeMiddle,
						Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5, LineHeight: 14}, StyleFunc: ui.Colored(colors.Faint)},
				}},
			}},
		}}
	})
}

// gitEmpty is the drawer's empty state.
func gitEmpty(colors ui.Colors, title, note string) core.Node {
	return core.View{Style: core.Style{FlexGrow: 1, Padding: core.All(18), Gap: 6}, Children: []core.Node{
		ui.Text(title, 13, ui.Semibold, colors.Text),
		core.Text{Content: note, Style: core.Style{FontSize: 11.5, LineHeight: 17}, StyleFunc: ui.Colored(colors.Muted)},
	}}
}

// gitNotRepo asks to initialize the folder.
func (a *app) gitNotRepo(cx *core.Scope, st gitState) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{Style: core.Style{FlexGrow: 1, Padding: core.All(18), Gap: 9, AlignItems: core.AlignStart}, Children: []core.Node{
		ui.Icon(lucide.FolderGit, 22, colors.Faint),
		ui.Text(apptext.T("这个项目还不是 Git 仓库"), 13, ui.Semibold, colors.Text),
		core.Text{ContentFunc: a.gitPath, MaxLines: 3, EllipsizeMode: core.EllipsizeMiddle,
			Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
		ui.Button{Text: apptext.T("初始化 Git 仓库"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, OnPress: a.gitInit},
		core.Show{When: func() bool { return st.Error != "" }, Then: func(cx *core.Scope) core.Node {
			return core.Text{Content: st.Error, Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Danger)}
		}},
	}}
}
