//go:build !js && !android && !ios

package workbench

// The Git drawer: the branch bar, the commit box, the changes with their
// stage, unstage and discard actions, and the history. The repository is
// read by git_repo.go; this file only draws it and sends the user's
// actions back.

import (
	"fmt"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// drawerGit keeps navigation and commit controls outside the scrolling
// content. Status polling updates their values without replacing the inputs.
func (a *app) drawerGit() core.Node {
	isRepo := func() bool { return a.git.state.Get().IsRepo }
	return core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), MinWidth: core.Pt(0), Gap: 8},
		Children: []core.Node{
			core.Show{When: isRepo, Then: func(cx *core.Scope) core.Node { return a.gitHeader(cx) }},
			core.Show{When: func() bool { return a.git.err.Get() != "" }, Then: func(cx *core.Scope) core.Node { return a.gitError(cx) }},
			core.Show{When: func() bool { return !isRepo() }, Then: func(cx *core.Scope) core.Node {
				return core.Scroll{Style: ui.FillRest, Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node { return a.gitStateNote(cx) })}}
			}},
			core.Show{When: isRepo, Then: func(cx *core.Scope) core.Node {
				return core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), Gap: 12}, Children: []core.Node{
					ui.Tabs[string]{Variant: ui.TabsSegmented, Equal: true, Size: ui.SizeSmall, Label: "Git", TestID: "git-sections",
						Value: a.git.panel.Get, OnChange: a.git.panel.Set,
						OptionsFunc: func() []ui.Option[string] {
							st := a.git.state.Get()
							return []ui.Option[string]{
								{Value: "changes", Label: fmt.Sprintf("%s %d", apptext.T("更改"), len(st.Files)), TestID: "git-tab-changes"},
								{Value: "history", Label: apptext.T("历史"), TestID: "git-tab-history"},
							}
						}},
					core.Show{When: func() bool { return a.git.panel.Get() == "changes" }, Then: func(cx *core.Scope) core.Node {
						return a.scrollStashFor("drawerGit:changes").Bind(cx, core.Scroll{TestID: "git-scroll", Style: ui.FillRest, Children: []core.Node{
							core.View{Style: core.Style{Gap: 16, Padding: core.Edges{Bottom: 16}}, Children: []core.Node{a.gitChanges(cx), a.gitPathNote(cx)}},
						}})
					}},
					core.Show{When: func() bool { return a.git.panel.Get() == "history" }, Then: func(cx *core.Scope) core.Node {
						return a.scrollStashFor("drawerGit:history").Bind(cx, core.Scroll{TestID: "git-history-scroll", Style: ui.FillRest, Children: []core.Node{
							core.View{Style: core.Style{Gap: 16, Padding: core.Edges{Bottom: 16}}, Children: []core.Node{a.gitHistory(cx), a.gitPathNote(cx)}},
						}})
					}},
					core.Show{When: func() bool { return a.git.panel.Get() == "changes" }, Then: func(cx *core.Scope) core.Node { return a.gitCommitBox(cx) }},
				}}
			}},
		}}
}

// gitStateNote is what the drawer shows instead of the repository: an empty
// panel, the first read, a folder that is not a repository, or a failure.
func (a *app) gitStateNote(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	if a.gitPath() == "" {
		return gitEmpty(colors, apptext.T("先打开一个项目"), apptext.T("Git 面板显示当前项目的分支、改动与历史。"))
	}
	st := a.git.state.Get()
	switch {
	case st.IsRepo:
		return nil
	case !st.Checked && st.Loading:
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Edges{Top: 8}},
			Children: []core.Node{
				ui.Spinner{Size: 14, Label: apptext.T("读取 Git 仓库")},
				ui.Text(apptext.T("正在读取仓库…"), 12, ui.Regular, colors.Muted),
			}}
	case st.NotRepo:
		return a.gitNotRepo(cx, st)
	case st.Error != "":
		return core.View{Style: core.Style{Gap: 10, Padding: core.Edges{Top: 8}}, Children: []core.Node{
			ui.Text(apptext.T("无法读取 Git 仓库"), 13, ui.Semibold, colors.Danger),
			core.Text{Content: st.Error, Style: core.Style{FontSize: 12, LineHeight: 18}, StyleFunc: ui.Colored(colors.Muted)},
			core.View{Style: core.Style{Direction: core.Row}, Children: []core.Node{
				ui.Button{Text: apptext.T("重试"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() { a.git.refreshAll() }},
			}},
		}}
	}
	return nil
}

// gitPathNote is the repository's folder, so the panel says which checkout
// it is talking about.
func (a *app) gitPathNote(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.Text{ContentFunc: func() string {
		st := a.git.state.Get()
		if st.Root == "" {
			return shortPath(a.gitPath(), 48)
		}
		return shortPath(st.Root, 48)
	}, MaxLines: 2, EllipsizeMode: core.EllipsizeMiddle,
		Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Faint)}
}

// gitEmpty is the drawer's empty state.
func gitEmpty(colors ui.Colors, title, note string) core.Node {
	return core.View{Style: core.Style{Padding: core.Edges{Top: 10}, Gap: 6}, Children: []core.Node{
		ui.Text(title, 13.5, ui.Semibold, colors.Text),
		core.Text{Content: note, Style: core.Style{FontSize: 12, LineHeight: 18}, StyleFunc: ui.Colored(colors.Muted)},
	}}
}

// gitNotRepo asks to initialize the folder.
func (a *app) gitNotRepo(cx *core.Scope, st gitState) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{Style: core.Style{Padding: core.Edges{Top: 10}, Gap: 9, AlignItems: core.AlignStart}, Children: []core.Node{
		ui.Icon(lucide.FolderGit, 22, colors.Faint),
		ui.Text(apptext.T("这个项目还不是 Git 仓库"), 13, ui.Semibold, colors.Text),
		core.Text{ContentFunc: a.gitPath, MaxLines: 3, EllipsizeMode: core.EllipsizeMiddle,
			Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)},
		ui.Button{Text: apptext.T("初始化 Git 仓库"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, OnPress: a.gitInit},
		core.Show{When: func() bool { return st.Error != "" }, Then: func(cx *core.Scope) core.Node {
			return core.Text{Content: st.Error, Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Danger)}
		}},
	}}
}

// gitSectionTitle is a section's heading, in the same small label the
// drawer's other tabs use.
func gitSectionTitle(colors ui.Colors, title string) core.Node {
	return core.Text{Content: title, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
		Style:     core.Style{FontSize: 13, FontWeight: ui.Semibold},
		StyleFunc: ui.Colored(colors.Text)}
}

// gitCount is the quiet number beside a section's heading.
func gitCount(colors ui.Colors, count func() string) core.Node {
	return core.Text{ContentFunc: count, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 12},
		StyleFunc: ui.Colored(colors.Muted)}
}
