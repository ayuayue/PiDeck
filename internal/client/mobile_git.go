package client

// The phone's read-only view of a project's repository: branch, changed
// files, and one file's patch. Staging and commits stay on the desktop.

import (
	"fmt"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// openGit shows a project's repository, read-only.
func (a *mobileApp) openGit(project, name string) {
	a.gitProject.Set(project)
	a.gitName.Set(name)
	a.gitState.Set(remotewire.Git{})
	a.gitErr.Set("")
	a.gitOpen.Set(true)
	a.loadGit()
}

func (a *mobileApp) loadGit() {
	client := a.client
	project := a.gitProject.GetUntracked()
	if client == nil || project == "" || a.gitBusy.GetUntracked() {
		return
	}
	a.gitBusy.Set(true)
	a.gitErr.Set("")
	go func() {
		st, err := client.git(project)
		a.cx.Post(func() {
			a.gitBusy.Set(false)
			if err != nil {
				a.gitErr.Set(remoteErrorText(err))
				return
			}
			a.gitState.Set(st)
		})
	}()
}

// openGitDiff reads one changed file's patch.
func (a *mobileApp) openGitDiff(path string) {
	client := a.client
	project := a.gitProject.GetUntracked()
	if client == nil || project == "" {
		return
	}
	a.gitDiffTitle.Set(path)
	a.gitDiffText.Set("")
	a.gitDiffErr.Set("")
	a.gitDiffBusy.Set(true)
	a.gitDiffOpen.Set(true)
	go func() {
		patch, err := client.gitDiff(project, path)
		a.cx.Post(func() {
			a.gitDiffBusy.Set(false)
			if err != nil {
				a.gitDiffErr.Set(remoteErrorText(err))
				return
			}
			a.gitDiffText.Set(patch)
		})
	}()
}

// gitSheet lists a project's branch and changed files.
func (a *mobileApp) gitSheet() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		st := a.gitState.Get()
		var rows []core.Node
		switch {
		case a.gitBusy.Get() && !st.IsRepo:
			rows = append(rows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.All(12)}, Children: []core.Node{
				ui.Spinner{Size: 12}, ui.Text(apptext.T("正在读取仓库…"), 12, ui.Regular, colors.Muted)}})
		case a.gitErr.Get() != "":
			rows = append(rows, core.Text{Content: a.gitErr.Get(), MaxLines: 3, Style: core.Style{FontSize: 12},
				StyleFunc: ui.Colored(colors.Danger)})
		case !st.IsRepo:
			rows = append(rows, core.View{Style: core.Style{Padding: core.All(12), Gap: 4}, Children: []core.Node{
				ui.Text(apptext.T("这个项目不是 Git 仓库"), 12.5, ui.Medium, colors.Muted),
				core.Text{Content: st.Error, MaxLines: 2, Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Faint)},
			}})
		default:
			head := []core.Node{
				ui.Icon(lucide.GitBranch, 14, colors.Muted),
				core.Text{Content: st.Branch, MaxLines: 1, Style: core.Style{FlexGrow: 1, FontSize: 13, FontWeight: ui.Semibold},
					StyleFunc: ui.Colored(colors.Text)},
			}
			if st.Ahead > 0 {
				head = append(head, ui.Text(fmt.Sprintf("↑%d", st.Ahead), 10.5, ui.Medium, colors.Up))
			}
			if st.Behind > 0 {
				head = append(head, ui.Text(fmt.Sprintf("↓%d", st.Behind), 10.5, ui.Medium, colors.Danger))
			}
			head = append(head, ui.Icon(lucide.ChevronDown, 12, colors.Faint))
			rows = append(rows, core.View{OnPress: func(core.PressEvent) { a.gitBranchesOpen.Set(true) },
				Role: core.RoleButton, Label: apptext.T("切换分支"), TestID: "mobile-git-branches",
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7,
						Padding: core.Symmetric(8, 4), CornerRadius: 7, Active: &core.Style{Background: colors.Pressed()}}
				}, Children: head})
			if st.Upstream != "" {
				rows = append(rows, core.Text{Content: st.Upstream, MaxLines: 1, Style: core.Style{FontSize: 10.5},
					StyleFunc: ui.Colored(colors.Faint)})
			}
			rows = append(rows, core.View{Style: core.Style{Height: core.Pt(1), Margin: core.Symmetric(6, 0)}, StyleFunc: ui.Filled(colors.Line)})
			rows = append(rows, core.View{Style: core.Style{Direction: core.Row, Gap: 6, Padding: core.Symmetric(2, 4)}, Children: []core.Node{
				ui.Button{Text: apptext.T("获取"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "mobile-git-fetch",
					Disabled: func() bool { return a.gitSending.Get() }, OnPress: func() { a.gitSync("fetch") }},
				ui.Button{Text: apptext.T("拉取"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "mobile-git-pull",
					Disabled: func() bool { return a.gitSending.Get() }, OnPress: func() { a.gitSync("pull") }},
				ui.Button{Text: apptext.T("推送"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "mobile-git-push",
					Disabled: func() bool { return a.gitSending.Get() }, OnPress: func() { a.gitSync("push") }},
			}})
			if len(st.Files) == 0 {
				rows = append(rows, core.View{Style: core.Style{Padding: core.All(12)}, Children: []core.Node{
					ui.Text(apptext.T("工作区干净"), 12, ui.Regular, colors.Faint)}})
			}
			for i, f := range st.Files {
				file := f
				markColor := colors.Muted
				switch file.Mark {
				case "M":
					markColor = colors.Warn
				case "A":
					markColor = colors.Up
				case "D", "U":
					markColor = colors.Danger
				case "?":
					markColor = colors.Faint
				}
				row := []core.Node{
					core.View{Style: core.Style{Width: core.Pt(18), AlignItems: core.AlignCenter, FlexShrink: 0}, Children: []core.Node{
						ui.Text(file.Mark, 11, ui.Semibold, markColor)}},
					core.Text{Content: file.Path, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: viewkit.MonoFont(), FontSize: 11.5},
						StyleFunc: ui.Colored(colors.Text)},
				}
				if file.Staged {
					row = append(row, core.View{Style: core.Style{Padding: core.Symmetric(1, 5), CornerRadius: 4, Background: colors.Inset()},
						Children: []core.Node{ui.Text(apptext.T("已暂存"), 9, ui.Medium, colors.Faint)}})
				}
				stageIcon, stageLabel := lucide.Plus, "暂存"
				if file.Staged {
					stageIcon, stageLabel = lucide.Minus, "取消暂存"
				}
				row = append(row,
					a.pressIcon(stageIcon, stageLabel, 28, 14, func() bool { return a.gitSending.Get() },
						func() { a.gitStage(file.Path, !file.Staged) }, fmt.Sprintf("mobile-git-stage-%d", i)),
					a.pressIcon(lucide.ChevronRight, "查看改动", 28, 14, nil, func() { a.openGitDiff(file.Path) },
						fmt.Sprintf("mobile-git-file-%d", i)))
				rows = append(rows, core.View{
					StyleFunc: func() core.Style {
						return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, MinHeight: core.Pt(40),
							Padding: core.Symmetric(4, 6), CornerRadius: 7}
					},
					Children: row,
				})
			}
			if len(st.Commits) > 0 {
				rows = append(rows, core.View{Style: core.Style{Height: core.Pt(1), Margin: core.Symmetric(8, 0)}, StyleFunc: ui.Filled(colors.Line)})
				rows = append(rows, ui.Text(apptext.T("最近提交"), 10.5, ui.Medium, colors.Faint))
				for _, c := range st.Commits {
					commit := c
					rows = append(rows, core.View{TestID: "mobile-git-commit-row",
						Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, MinHeight: core.Pt(38),
							Padding: core.Symmetric(3, 6)}, Children: []core.Node{
							ui.Icon(lucide.GitCommitHorizontal, 12, colors.Faint),
							core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
								core.Text{Content: commit.Subject, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
									Style: core.Style{FontSize: 12}, StyleFunc: ui.Colored(colors.Text)},
								core.Text{Content: commit.Short + " · " + commit.Author + " · " + commit.When, MaxLines: 1,
									Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
							}},
						}})
				}
			}
		}
		staged := 0
		for _, f := range st.Files {
			if f.Staged {
				staged++
			}
		}
		commitBox := core.View{Style: core.Style{Gap: 6, Padding: core.Edges{Top: 4}}, Children: []core.Node{
			core.Input{Value: a.gitMsg.Get, OnChange: a.gitMsg.Set, Multiline: true, Placeholder: apptext.T("提交说明"), Label: apptext.T("提交说明"),
				TestID: "mobile-git-message",
				Style:  core.Style{MinHeight: core.Pt(52), MaxHeight: core.Pt(110), Padding: core.Symmetric(7, 9), FontSize: 12.5, Color: colors.Text()},
				StyleFunc: func() core.Style {
					return core.Style{Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 8,
						PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
				}},
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
				ui.Text(apptext.T("已暂存 %d", staged), 10.5, ui.Regular, colors.Faint),
				core.View{Style: core.Style{FlexGrow: 1}},
				ui.Button{Text: apptext.T("提交"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "mobile-git-commit",
					Disabled: func() bool { return a.gitSending.Get() || strings.TrimSpace(a.gitMsg.Get()) == "" || staged == 0 },
					OnPress:  a.commitGit},
			}},
		}}
		children := []core.Node{a.scrollStashFor("gitSheet:1").Bind(cx, core.Scroll{Style: core.Style{MaxHeight: core.Pt(380)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 2}, Children: rows}}})}
		if st.IsRepo && a.gitErr.Get() == "" {
			children = append(children, commitBox)
		}
		return sheetFrame(cx, sheetSpec{
			title: "Git · " + a.gitName.Get(), testID: "mobile-git", width: 520,
			open: a.gitOpen.Get, close: func() { a.gitOpen.Set(false) },
			body: []core.Node{core.View{Style: core.Style{Gap: 6}, Children: children}},
			footer: []core.Node{
				ui.Button{Text: apptext.T("刷新"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: a.loadGit},
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.gitOpen.Set(false) }},
			},
		})
	})
}

// gitStage stages or unstages one path.
func (a *mobileApp) gitStage(path string, stage bool) {
	client := a.client
	project := a.gitProject.GetUntracked()
	if client == nil || project == "" || a.gitSending.GetUntracked() {
		return
	}
	a.gitSending.Set(true)
	go func() {
		err := client.gitStage(project, path, stage)
		a.cx.Post(func() {
			a.gitSending.Set(false)
			if err != nil {
				a.flash(remoteErrorText(err))
				return
			}
			a.flash("已更新暂存区")
			a.loadGit()
		})
	}()
}

// commitGit commits what is staged.
func (a *mobileApp) commitGit() {
	client := a.client
	project := a.gitProject.GetUntracked()
	msg := strings.TrimSpace(a.gitMsg.GetUntracked())
	if client == nil || project == "" || msg == "" || a.gitSending.GetUntracked() {
		return
	}
	a.gitSending.Set(true)
	go func() {
		err := client.gitCommit(project, msg)
		a.cx.Post(func() {
			a.gitSending.Set(false)
			if err != nil {
				a.flash(remoteErrorText(err))
				return
			}
			a.gitMsg.Set("")
			a.flash("已提交")
			a.loadGit()
		})
	}()
}

// gitCheckout switches to a local branch.
func (a *mobileApp) gitCheckout(branch string) {
	client := a.client
	project := a.gitProject.GetUntracked()
	if client == nil || project == "" || a.gitSending.GetUntracked() {
		return
	}
	a.gitBranchesOpen.Set(false)
	if a.gitState.GetUntracked().Branch == branch {
		return
	}
	a.gitSending.Set(true)
	go func() {
		err := client.gitCheckout(project, branch)
		a.cx.Post(func() {
			a.gitSending.Set(false)
			if err != nil {
				a.flash(remoteErrorText(err))
				return
			}
			a.flash("已切换到 " + branch)
			a.loadGit()
		})
	}()
}

// gitSync fetches, pulls or pushes.
func (a *mobileApp) gitSync(action string) {
	client := a.client
	project := a.gitProject.GetUntracked()
	if client == nil || project == "" || a.gitSending.GetUntracked() {
		return
	}
	label := map[string]string{"fetch": "获取", "pull": "拉取", "push": "推送"}[action]
	if label == "" {
		return
	}
	a.gitSending.Set(true)
	go func() {
		err := client.gitSync(project, action)
		a.cx.Post(func() {
			a.gitSending.Set(false)
			if err != nil {
				a.flash(remoteErrorText(err))
				return
			}
			a.flash(label + "完成")
			a.loadGit()
		})
	}()
}

// gitBranchesSheet lists the local branches and switches on a tap.
func (a *mobileApp) gitBranchesSheet() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		st := a.gitState.Get()
		var rows []core.Node
		for i, b := range st.Branches {
			branch := b
			row := []core.Node{
				ui.Icon(lucide.GitBranch, 13, colors.Muted),
				core.Text{Content: branch, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
					Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: viewkit.MonoFont(), FontSize: 12},
					StyleFunc: ui.Colored(colors.Text)},
			}
			if branch == st.Branch {
				row = append(row, ui.Text(apptext.T("当前"), 10, ui.Medium, colors.Up))
			}
			rows = append(rows, core.View{OnPress: func(core.PressEvent) { a.gitCheckout(branch) },
				Role: core.RoleButton, Label: branch, TestID: fmt.Sprintf("mobile-git-branch-%d", i),
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(42),
						Padding: core.Symmetric(4, 8), CornerRadius: 7, Active: &core.Style{Background: colors.Pressed()}}
				}, Children: row})
		}
		if len(rows) == 0 {
			rows = append(rows, core.View{Style: core.Style{Padding: core.All(12)}, Children: []core.Node{
				ui.Text(apptext.T("没有本地分支"), 12, ui.Regular, colors.Faint)}})
		}
		return ui.Dialog{
			Open:         a.gitBranchesOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.gitBranchesOpen.Set(open) },
			Title:        apptext.T("切换分支"),
			TestID:       "mobile-git-branches-sheet",
			Style:        core.Style{Width: core.Pct(100), MaxWidth: core.Pt(520)},
			Children: []core.Node{a.scrollStashFor("gitBranchesSheet:1").Bind(cx, core.Scroll{Style: core.Style{MaxHeight: core.Pt(380)},
				Children: []core.Node{core.View{Style: core.Style{Gap: 2}, Children: rows}}})},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.gitBranchesOpen.Set(false) }},
			},
		}
	})
}

// gitDiffSheet shows one file's patch.
func (a *mobileApp) gitDiffSheet() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		var body core.Node
		switch {
		case a.gitDiffBusy.Get():
			body = core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.All(16)}, Children: []core.Node{
				ui.Spinner{Size: 12}, ui.Text(apptext.T("正在读取改动…"), 12, ui.Regular, colors.Muted)}}
		case a.gitDiffErr.Get() != "":
			body = core.View{Style: core.Style{Padding: core.All(16)}, Children: []core.Node{
				ui.Text(a.gitDiffErr.Get(), 12, ui.Regular, colors.Danger)}}
		case strings.TrimSpace(a.gitDiffText.Get()) == "":
			body = core.View{Style: core.Style{Padding: core.All(16)}, Children: []core.Node{
				ui.Text(apptext.T("没有可显示的差异"), 12, ui.Regular, colors.Faint)}}
		default:
			body = patchBody(func() string { return a.gitDiffText.Get() }, "mobile-git-diff-body")
		}
		return ui.Dialog{
			Open:         a.gitDiffOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.gitDiffOpen.Set(open) },
			Title:        a.gitDiffTitle.Get(),
			TestID:       "mobile-git-diff",
			Style:        core.Style{Width: core.Pct(100), MaxWidth: patchSheetWidth(cx)},
			Children:     []core.Node{body},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "mobile-git-diff-close",
					OnPress: func() { a.gitDiffOpen.Set(false) }},
			},
		}
	})
}
