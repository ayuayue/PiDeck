//go:build !js && !android && !ios

package workbench

// The Git drawer's branch bar: the branch and its upstream, how far it has
// drifted from the remote, and the sync actions. It is mounted once and
// reads the panel state through functions, so a status read patches it in
// place instead of rebuilding it under an open menu.

import (
	"fmt"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// gitHeader is the branch, its upstream, and the sync buttons.
func (a *app) gitHeader(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	sync := func() bool { return a.git.busy.Get() != "" }
	branchName := func() string {
		st := a.git.state.Get()
		if st.Detached {
			return "HEAD · " + shortOID(st.OID)
		}
		if st.Branch == "" {
			return apptext.T("分支")
		}
		return st.Branch
	}
	trigger := core.View{OnPress: func(core.PressEvent) {
		a.gitBranches.Update(func(v bool) bool { return !v })
		if a.gitBranches.GetUntracked() {
			a.git.refreshAll()
		}
	}, Role: core.RoleButton, Label: apptext.T("切换分支"), TestID: "git-branch",
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(viewkit.PanelControlSize), MinWidth: core.Pt(0), FlexShrink: 1,
				Padding: core.Symmetric(0, 8), CornerRadius: 6, Transition: viewkit.PressMotion,
				Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()},
				FocusVisible: ui.FocusRing(cx, 2)}
		}, Children: []core.Node{
			ui.Icon(lucide.GitBranch, viewkit.PanelIconSize, colors.Muted),
			core.Text{ContentFunc: branchName, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style: core.Style{FontSize: viewkit.PanelTitleSize, FontWeight: ui.Medium, LineHeight: 24, MinWidth: core.Pt(0), FlexShrink: 1}, StyleFunc: ui.Colored(colors.Text)},
			ui.Icon(lucide.ChevronDown, 12, colors.Faint),
			core.Show{When: func() bool { return a.git.state.Get().Ahead > 0 }, Then: func(*core.Scope) core.Node {
				return gitSyncChip(colors, func() string { return fmt.Sprintf("↑%d", a.git.state.Get().Ahead) }, colors.Up())
			}},
			core.Show{When: func() bool { return a.git.state.Get().Behind > 0 }, Then: func(*core.Scope) core.Node {
				return gitSyncChip(colors, func() string { return fmt.Sprintf("↓%d", a.git.state.Get().Behind) }, colors.Down())
			}},
		}}
	branchMenu := a.popoverCard(a.gitBranches, core.PlaceBottom, core.AlignStart, 246, trigger, func(cx *core.Scope) core.Node {
		return a.gitBranchMenu(cx)
	}, "git-branches-menu")

	return core.View{Style: core.Style{Gap: viewkit.PanelGap, FlexShrink: 0}, Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 2}, Children: []core.Node{
			branchMenu,
			core.View{Style: core.Style{FlexGrow: 1}},
			core.Dynamic(func(*core.Scope) core.Node {
				if busy := a.git.busy.Get(); busy != "" {
					return ui.Spinner{Size: viewkit.PanelDetailIconSize, Label: busy}
				}
				return nil
			}),

			hint("刷新 Git", a.pressIcon(lucide.RefreshCw, apptext.T("刷新 Git"), viewkit.PanelControlSize, viewkit.PanelIconSize, sync, func() { a.git.refreshAll() }, "git-refresh")),
			a.gitMoreMenu(cx),
		}},
		a.gitUpstreamLine(cx),
		core.View{Style: core.Style{Direction: core.Row, Gap: 8}, Children: []core.Node{
			hint("获取远程（fetch）", ui.Button{Text: apptext.T("获取"), Label: apptext.T("获取远程（fetch）"), Icon: lucide.CloudDownload, Variant: ui.ButtonSecondary, Size: ui.SizeSmall, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Height: core.Pt(viewkit.PanelControlSize)}, Disabled: sync, OnPress: a.gitFetch, TestID: "git-fetch", IconSize: viewkit.PanelDetailIconSize}),
			hint("拉取（pull）", ui.Button{Text: apptext.T("拉取"), Label: apptext.T("拉取（pull）"), Icon: lucide.ArrowDownToLine, Variant: ui.ButtonGhost, Size: ui.SizeSmall, IconSize: viewkit.PanelDetailIconSize, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Height: core.Pt(viewkit.PanelControlSize)}, Disabled: sync, OnPress: a.gitPull, TestID: "git-pull"}),
			hint("推送（push）", ui.Button{Text: apptext.T("推送"), Label: apptext.T("推送（push）"), Icon: lucide.ArrowUpFromLine, Variant: ui.ButtonGhost, Size: ui.SizeSmall, IconSize: viewkit.PanelDetailIconSize, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Height: core.Pt(viewkit.PanelControlSize)}, Disabled: sync, OnPress: func() { a.gitPush(false) }, TestID: "git-push"}),
		}},
	}}
}

// gitMoreMenu is the drawer's "more" menu. It anchors to its button: a
// context menu would open at the pointer, at the window's corner for a
// keyboard press.
func (a *app) gitMoreMenu(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return base.Menu{
		Open: a.gitMoreOpen.Get, OnOpenChange: func(open bool, _ base.Reason) { a.gitMoreOpen.Set(open) },
		Trigger: ui.Icon(lucide.Ellipsis, viewkit.PanelIconSize, colors.Muted),
		Label:   apptext.T("更多 Git 操作"), TestID: "git-more",
		Placement: core.PlaceBottom, Align: core.AlignEnd, Offset: 4, Margin: 8,
		Style: core.Style{Width: core.Pt(viewkit.PanelControlSize), Height: core.Pt(viewkit.PanelControlSize), FlexShrink: 0, CornerRadius: 6,
			AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter},
		StyleFunc: func() core.Style {
			return core.Style{Transition: viewkit.PressMotion, Hover: &core.Style{Background: colors.Hover()},
				Active: &core.Style{Background: colors.Pressed()}, FocusVisible: ui.FocusRing(a.cx, 2)}
		},
		PopupStyle: a.menuPopup(cx), PopupStyleFunc: func() core.Style { return a.menuCard(a.cx) },
		Children: []core.Node{
			ui.MenuItem{Text: apptext.T("远端…"), Icon: lucide.Cloud, OnSelect: a.openGitRemotes},
			ui.MenuItem{Text: apptext.T("标签…"), Icon: lucide.Tag, OnSelect: a.openGitTags},
			ui.MenuItem{Text: apptext.T("未推送的提交…"), Icon: lucide.CloudUpload, OnSelect: a.openUnpushedCommits},
			ui.MenuItem{Text: apptext.T("撤销上次提交…"), Icon: lucide.Undo2, Variant: ui.MenuItemDanger, OnSelect: a.gitResetLast},
			ui.MenuItem{Text: apptext.T("贮藏列表…"), Icon: lucide.Archive, OnSelect: a.openGitStashList},
			ui.MenuItem{Text: apptext.T("贮藏全部改动"), Icon: lucide.Archive, OnSelect: a.gitStash},
			ui.MenuItem{Text: apptext.T("恢复最近贮藏"), Icon: lucide.ArchiveRestore, OnSelect: a.gitStashPop},
			ui.MenuItem{Text: apptext.T("丢弃全部改动"), Icon: lucide.Undo2, Variant: ui.MenuItemDanger, OnSelect: a.gitDiscardAll},
			ui.MenuItem{Text: apptext.T("初始化 Git 仓库"), Icon: lucide.FolderGit, OnSelect: a.gitInit},
		},
	}
}

// gitUpstreamLine names the branch's upstream, or offers to publish it.
func (a *app) gitUpstreamLine(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.Dynamic(func(cx *core.Scope) core.Node {
		st := a.git.state.Get()
		icon := ui.Icon(lucide.Cloud, viewkit.PanelDetailIconSize, colors.Muted)
		if st.Branch == "" || st.Detached {
			return nil
		}
		if st.Upstream == "" {
			if st.Initial {
				return nil
			}
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				icon,
				ui.Text(apptext.T("这个分支还没有上游"), viewkit.PanelCaptionSize, ui.Regular, colors.Muted),
				ui.Button{Text: apptext.T("发布到 origin"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.gitPush(true) }},
			}}
		}
		row := []core.Node{
			icon,
			core.Text{Content: st.Upstream, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: viewkit.PanelCaptionSize, LineHeight: viewkit.PanelLineHeight, FlexShrink: 1, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Muted)},
		}
		if st.Ahead == 0 && st.Behind == 0 {
			row = append(row, ui.Text(apptext.T("已同步"), viewkit.PanelCaptionSize, ui.Regular, colors.Muted))
		}
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinWidth: core.Pt(0)}, Children: row}
	})
}

// gitBranchMenu is the branch picker's body: local branches, remote
// branches and the way to a new one.
func (a *app) gitBranchMenu(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	st := a.git.state.Get()
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
		core.View{Style: core.Style{Gap: 1, MinWidth: core.Pt(0), Padding: core.Edges{Right: viewkit.PanelInset}}, Children: rows}}}
}

// shortOID is a commit hash in the seven characters a log shows.
func shortOID(oid string) string {
	if len(oid) > 7 {
		return oid[:7]
	}
	return oid
}

// gitSyncChip is a small ahead or behind count.
func gitSyncChip(colors ui.Colors, text func() string, tone core.Color) core.Node {
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Height: core.Pt(20),
		Padding: core.Symmetric(0, 6), CornerRadius: 6, Background: ui.Alpha(tone, 0.10)},
		Children: []core.Node{core.Text{ContentFunc: text, Style: core.Style{FontSize: viewkit.PanelMicroSize, FontWeight: ui.Medium},
			StyleFunc: ui.Colored(func() core.Color { return tone })}}}
}

// gitError is the last action's failure, dismissible.
func (a *app) gitError(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{StyleFunc: func() core.Style {
		return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Symmetric(6, 8), CornerRadius: 6,
			Background: ui.Alpha(colors.Danger(), 0.08)}
	}, Children: []core.Node{
		ui.Icon(lucide.TriangleAlert, viewkit.PanelDetailIconSize, colors.Danger),
		core.Text{ContentFunc: a.git.err.Get, MaxLines: 3, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: viewkit.PanelCaptionSize, LineHeight: viewkit.PanelLineHeight},
			StyleFunc: ui.Colored(colors.Danger)},
		core.View{OnPress: func(core.PressEvent) { a.git.err.Set("") }, Role: core.RoleButton, Label: apptext.T("关闭错误"),
			StyleFunc: func() core.Style {
				return core.Style{Width: core.Pt(viewkit.PanelActionSize), Height: core.Pt(viewkit.PanelActionSize), AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
					CornerRadius: 4, Hover: &core.Style{Background: colors.Hover()}}
			}, Children: []core.Node{ui.Icon(lucide.X, viewkit.PanelDetailIconSize, colors.Danger)}},
	}}
}
