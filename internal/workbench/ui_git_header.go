//go:build !js && !android && !ios

package workbench

// The Git drawer: the branch and its upstream, changed files with their
// stage, unstage and discard actions, the commit box, the history and the
// patch dialog. The repository is read by git.go; this file only draws it
// and sends the user's actions back.

import (
	"fmt"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// gitHeader is the branch, its upstream, and the sync buttons.
func (a *app) gitHeader(cx *core.Scope, st gitState) core.Node {
	colors := ui.ColorsOf(cx)
	branch := st.Branch
	if branch == "" {
		branch = "HEAD"
	}
	if st.Detached {
		short := st.OID
		if len(short) > 7 {
			short = short[:7]
		}
		branch = "HEAD · " + short
	}
	trigger := core.Dynamic(func(cx *core.Scope) core.Node {
		children := []core.Node{
			ui.Icon(lucide.GitBranch, 13, colors.Muted),
			core.Text{ContentFunc: func() string {
				if st.Detached {
					short := st.OID
					if len(short) > 7 {
						short = short[:7]
					}
					return "HEAD · " + short
				}
				if st.Branch == "" {
					return apptext.T("分支")
				}
				return st.Branch
			}, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style: core.Style{FontSize: 12.5, FontWeight: ui.Semibold, MinWidth: core.Pt(0), FlexShrink: 1}, StyleFunc: ui.Colored(colors.Text)},
			ui.Icon(lucide.ChevronDown, 10, colors.Faint),
		}
		if st.Ahead > 0 {
			children = append(children, gitSyncChip(colors, fmt.Sprintf("↑%d", st.Ahead), colors.Up()))
		}
		if st.Behind > 0 {
			children = append(children, gitSyncChip(colors, fmt.Sprintf("↓%d", st.Behind), colors.Down()))
		}
		return core.View{OnPress: func(core.PressEvent) {
			a.gitBranches.Update(func(v bool) bool { return !v })
			if a.gitBranches.GetUntracked() {
				a.git.refreshAll()
			}
		}, Role: core.RoleButton, Label: apptext.T("切换分支"), TestID: "git-branch",
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Height: core.Pt(26), MinWidth: core.Pt(0),
					Padding: core.Symmetric(0, 6), CornerRadius: 6, Transition: viewkit.PressMotion,
					Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
			}, Children: children}
	})
	branchMenu := a.popoverCard(a.gitBranches, core.PlaceBottom, core.AlignStart, 246, trigger, func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		var rows []core.Node
		for _, name := range st.Branches {
			b := name
			current := b == st.Branch
			children := []core.Node{
				core.View{Style: core.Style{Width: core.Pt(14), AlignItems: core.AlignCenter}, Children: []core.Node{
					core.Show{When: func() bool { return current }, Then: func(*core.Scope) core.Node { return ui.Icon(lucide.Check, 12, colors.Text) }},
				}},
				core.Text{Content: b, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
					Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12}, StyleFunc: ui.Colored(colors.Text)},
			}
			if !current {
				children = append(children, core.View{OnPress: func(core.PressEvent) { a.gitDeleteBranch(b) },
					Role: core.RoleButton, Label: apptext.T("删除分支") + " " + b, TestID: "git-branch-delete-" + b,
					StyleFunc: func() core.Style {
						return core.Style{Width: core.Pt(20), Height: core.Pt(20), CornerRadius: 5, AlignItems: core.AlignCenter,
							JustifyContent: core.JustifyCenter, Hover: &core.Style{Background: colors.Pressed()}}
					},
					Children: []core.Node{ui.Icon(lucide.Trash, 10, colors.Faint)}})
			}
			rows = append(rows, core.View{
				OnPress: func(core.PressEvent) { a.gitCheckout(b) },
				Role:    core.RoleOption, Label: b,
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Height: core.Pt(28),
						Padding: core.Symmetric(0, 8), CornerRadius: 6, Transition: viewkit.PressMotion,
						Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
				},
				Children: children,
			})
		}
		if len(rows) == 0 {
			rows = append(rows, core.Text{Content: apptext.T("没有本地分支"), Style: core.Style{FontSize: 11.5, Padding: core.All(8)},
				StyleFunc: ui.Colored(colors.Faint)})
		}
		if len(st.RemoteBranches) > 0 {
			rows = append(rows, core.View{Style: core.Style{Height: core.Pt(1), Margin: core.Symmetric(4, 4)}, StyleFunc: ui.Filled(colors.Line)})
			rows = append(rows, core.Text{Content: apptext.T("远程分支"), Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9,
				Padding: core.Edges{Left: 8, Top: 4, Bottom: 2}}, StyleFunc: ui.Colored(colors.Faint)})
			for _, name := range st.RemoteBranches {
				b := name
				rows = append(rows, core.View{
					OnPress: func(core.PressEvent) { a.gitCheckoutRemote(b) },
					Role:    core.RoleOption, Label: b,
					StyleFunc: func() core.Style {
						return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Height: core.Pt(28),
							Padding: core.Symmetric(0, 8), CornerRadius: 6, Transition: viewkit.PressMotion,
							Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
					},
					Children: []core.Node{
						core.View{Style: core.Style{Width: core.Pt(14), AlignItems: core.AlignCenter},
							Children: []core.Node{ui.Icon(lucide.Cloud, 11, colors.Faint)}},
						core.Text{Content: b, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12}, StyleFunc: ui.Colored(colors.Muted)},
						core.View{OnPress: func(core.PressEvent) { a.gitDeleteRemoteBranch(b) },
							Role: core.RoleButton, Label: apptext.T("删除远程分支") + " " + b, TestID: "git-remote-delete-" + b,
							StyleFunc: func() core.Style {
								return core.Style{Width: core.Pt(20), Height: core.Pt(20), CornerRadius: 5, AlignItems: core.AlignCenter,
									JustifyContent: core.JustifyCenter, Hover: &core.Style{Background: colors.Pressed()}}
							},
							Children: []core.Node{ui.Icon(lucide.Trash, 10, colors.Faint)}},
					},
				})
			}
		}
		rows = append(rows, core.View{Style: core.Style{Height: core.Pt(1), Margin: core.Symmetric(4, 4)}, StyleFunc: ui.Filled(colors.Line)})
		rows = append(rows, core.View{
			OnPress: func(core.PressEvent) {
				a.gitBranches.Set(false)
				a.gitNewBranchName.Set("")
				a.gitNewBranchOpen.Set(true)
			},
			Role: core.RoleButton, Label: apptext.T("新建分支"),
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Height: core.Pt(28),
					Padding: core.Symmetric(0, 8), CornerRadius: 6, Transition: viewkit.PressMotion,
					Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
			},
			Children: []core.Node{
				ui.Icon(lucide.GitBranchPlus, 13, colors.Muted),
				ui.Text(apptext.T("新建分支…"), 12, ui.Regular, colors.Text),
			},
		})
		return core.Scroll{Style: core.Style{MaxHeight: core.Pt(360), Width: core.Pt(234)}, Children: []core.Node{
			core.View{Style: core.Style{Gap: 1, MinWidth: core.Pt(0)}, Children: rows}}}
	}, "git-branches-menu")

	return core.View{Style: core.Style{Gap: 6, FlexShrink: 0}, Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4}, Children: []core.Node{
			branchMenu,
			core.View{Style: core.Style{FlexGrow: 1}},
			core.Dynamic(func(*core.Scope) core.Node {
				if busy := a.git.busy.Get(); busy != "" {
					return ui.Spinner{Size: 12, Label: busy}
				}
				return nil
			}),
			a.pressIcon(lucide.CloudDownload, apptext.T("获取远程（fetch）"), 24, 13,
				func() bool { return a.git.busy.Get() != "" }, a.gitFetch, ""),
			a.pressIcon(lucide.ArrowDownToLine, apptext.T("拉取（pull）"), 24, 13,
				func() bool { return a.git.busy.Get() != "" }, a.gitPull, ""),
			a.pressIcon(lucide.ArrowUpFromLine, apptext.T("推送（push）"), 24, 13,
				func() bool { return a.git.busy.Get() != "" }, func() { a.gitPush(false) }, ""),
			a.pressIcon(lucide.RefreshCw, apptext.T("刷新 Git"), 24, 12.5,
				func() bool { return a.git.busy.Get() != "" }, func() { a.git.refreshAll() }, ""),
			ui.ContextMenu{Open: a.gitMoreOpen.Get,
				OnOpenChange: func(open bool, _ base.Reason) { a.gitMoreOpen.Set(open) },
				Trigger: a.pressIcon(lucide.Ellipsis, apptext.T("更多 Git 操作"), 24, 14, nil,
					func() { a.gitMoreOpen.Update(func(v bool) bool { return !v }) }, "git-more"),
				TestID: "git-more-menu", Children: []core.Node{
					ui.MenuItem{Text: apptext.T("远端…"), Icon: lucide.Cloud, OnSelect: a.openGitRemotes},
					ui.MenuItem{Text: apptext.T("标签…"), Icon: lucide.Tag, OnSelect: a.openGitTags},
					ui.MenuItem{Text: apptext.T("未推送的提交…"), Icon: lucide.CloudUpload, OnSelect: a.openUnpushedCommits},
					ui.MenuItem{Text: apptext.T("撤销上次提交…"), Icon: lucide.Undo2, Variant: ui.MenuItemDanger, OnSelect: a.gitResetLast},
					ui.MenuItem{Text: apptext.T("贮藏列表…"), Icon: lucide.Archive, OnSelect: a.openGitStashList},
					ui.MenuItem{Text: apptext.T("贮藏全部改动"), Icon: lucide.Archive, OnSelect: a.gitStash},
					ui.MenuItem{Text: apptext.T("恢复最近贮藏"), Icon: lucide.ArchiveRestore, OnSelect: a.gitStashPop},
					ui.MenuItem{Text: apptext.T("丢弃全部改动"), Icon: lucide.Undo2, Variant: ui.MenuItemDanger, OnSelect: a.gitDiscardAll},
					ui.MenuItem{Text: apptext.T("初始化 Git 仓库"), Icon: lucide.FolderGit, OnSelect: a.gitInit},
				}},
		}},
		core.Dynamic(func(*core.Scope) core.Node {
			if st.Upstream == "" {
				if st.Initial || st.Detached || st.Branch == "" {
					return nil
				}
				return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					ui.Icon(lucide.Cloud, 11, colors.Faint),
					ui.Text(apptext.T("这个分支还没有上游"), 10.5, ui.Regular, colors.Faint),
					ui.Button{Text: apptext.T("发布到 origin"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.gitPush(true) }},
				}}
			}
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5}, Children: []core.Node{
				ui.Icon(lucide.Cloud, 11, colors.Faint),
				core.Text{Content: st.Upstream, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
					Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5, FlexShrink: 1, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Faint)},
			}}
		}),
	}}
}

// gitSyncChip is a small ahead/behind count.
func gitSyncChip(colors ui.Colors, text string, tone core.Color) core.Node {
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Height: core.Pt(16),
		Padding: core.Symmetric(0, 4), CornerRadius: 4, Background: ui.Alpha(tone, 0.10)},
		Children: []core.Node{ui.Text(text, 9, ui.Medium, func() core.Color { return tone })}}
}

// gitError is the last action's failure, dismissible.
func (a *app) gitError(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{StyleFunc: func() core.Style {
		return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Symmetric(6, 8), CornerRadius: 6,
			Background: ui.Alpha(colors.Danger(), 0.08)}
	}, Children: []core.Node{
		ui.Icon(lucide.TriangleAlert, 12, colors.Danger),
		core.Text{ContentFunc: a.git.err.Get, MaxLines: 3, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11, LineHeight: 16},
			StyleFunc: ui.Colored(colors.Danger)},
		core.View{OnPress: func(core.PressEvent) { a.git.err.Set("") }, Role: core.RoleButton, Label: apptext.T("关闭错误"),
			StyleFunc: func() core.Style {
				return core.Style{Width: core.Pt(18), Height: core.Pt(18), AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
					CornerRadius: 4, Hover: &core.Style{Background: colors.Hover()}}
			}, Children: []core.Node{ui.Icon(lucide.X, 10, colors.Danger)}},
	}}
}
