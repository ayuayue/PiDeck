package main

// The phone's read-only view of a project's repository: branch, changed
// files, and one file's patch. Staging and commits stay on the desktop.

import (
	"fmt"
	"strings"

	"github.com/oneo-me/nsgo/base"
	"github.com/oneo-me/nsgo/core"
	"github.com/oneo-me/nsgo/icons/lucide"
	"github.com/oneo-me/nsgo/ui"
)

// openGit shows a project's repository, read-only.
func (a *mobileApp) openGit(project, name string) {
	a.gitProject.Set(project)
	a.gitName.Set(name)
	a.gitState.Set(remoteWireGit{})
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
	a.gitDiffBusy.Set(true)
	a.gitDiffOpen.Set(true)
	go func() {
		patch, err := client.gitDiff(project, path)
		a.cx.Post(func() {
			a.gitDiffBusy.Set(false)
			if err != nil {
				a.gitDiffText.Set(remoteErrorText(err))
				return
			}
			if strings.TrimSpace(patch) == "" {
				patch = "（这里没有可显示的差异）"
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
				ui.Spinner{Size: 12}, ui.Text("正在读取仓库…", 12, ui.Regular, colors.Muted)}})
		case a.gitErr.Get() != "":
			rows = append(rows, core.Text{Content: a.gitErr.Get(), MaxLines: 3, Style: core.Style{FontSize: 12},
				StyleFunc: ui.Colored(colors.Danger)})
		case !st.IsRepo:
			rows = append(rows, core.View{Style: core.Style{Padding: core.All(12), Gap: 4}, Children: []core.Node{
				ui.Text("这个项目不是 Git 仓库", 12.5, ui.Medium, colors.Muted),
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
			rows = append(rows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7,
				Padding: core.Symmetric(8, 4)}, Children: head})
			if st.Upstream != "" {
				rows = append(rows, core.Text{Content: st.Upstream, MaxLines: 1, Style: core.Style{FontSize: 10.5},
					StyleFunc: ui.Colored(colors.Faint)})
			}
			rows = append(rows, core.View{Style: core.Style{Height: core.Pt(1), Margin: core.Symmetric(6, 0)}, StyleFunc: ui.Filled(colors.Line)})
			if len(st.Files) == 0 {
				rows = append(rows, core.View{Style: core.Style{Padding: core.All(12)}, Children: []core.Node{
					ui.Text("工作区干净", 12, ui.Regular, colors.Faint)}})
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
						Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: ui.Mono, FontSize: 11.5},
						StyleFunc: ui.Colored(colors.Text)},
				}
				if file.Staged {
					row = append(row, core.View{Style: core.Style{Padding: core.Symmetric(1, 5), CornerRadius: 4, Background: colors.Inset()},
						Children: []core.Node{ui.Text("已暂存", 9, ui.Medium, colors.Faint)}})
				}
				rows = append(rows, core.View{
					OnPress: func(core.PressEvent) { a.openGitDiff(file.Path) },
					Role:    core.RoleButton, Label: file.Path, TestID: fmt.Sprintf("mobile-git-file-%d", i),
					StyleFunc: func() core.Style {
						return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, MinHeight: core.Pt(40),
							Padding: core.Symmetric(4, 6), CornerRadius: 7, Active: &core.Style{Background: colors.Pressed()}}
					},
					Children: row,
				})
			}
		}
		return ui.Dialog{
			Open:         a.gitOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.gitOpen.Set(open) },
			Title:        "Git · " + a.gitName.Get(),
			TestID:       "mobile-git",
			Style:        core.Style{Width: core.Pct(100), MaxWidth: core.Pt(520)},
			Children: []core.Node{core.Scroll{Style: core.Style{MaxHeight: core.Pt(430)},
				Children: []core.Node{core.View{Style: core.Style{Gap: 2}, Children: rows}}}},
			Footer: []core.Node{
				ui.Button{Text: "刷新", Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: a.loadGit},
				ui.Button{Text: "关闭", Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.gitOpen.Set(false) }},
			},
		}
	})
}

// gitDiffSheet shows one file's patch.
func (a *mobileApp) gitDiffSheet() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		var body core.Node
		if a.gitDiffBusy.Get() {
			body = core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.All(16)}, Children: []core.Node{
				ui.Spinner{Size: 12}, ui.Text("正在读取改动…", 12, ui.Regular, colors.Muted)}}
		} else {
			body = core.Scroll{Style: core.Style{MaxHeight: core.Pt(430)}, Children: []core.Node{
				core.Text{Content: a.gitDiffText.Get(), Selectable: core.SelectableOn,
					Style: core.Style{FontFamily: ui.Mono, FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Text)}}}
		}
		return ui.Dialog{
			Open:         a.gitDiffOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.gitDiffOpen.Set(open) },
			Title:        a.gitDiffTitle.Get(),
			TestID:       "mobile-git-diff",
			Style:        core.Style{Width: core.Pct(100), MaxWidth: core.Pt(520)},
			Children:     []core.Node{body},
			Footer: []core.Node{
				ui.Button{Text: "关闭", Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.gitDiffOpen.Set(false) }},
			},
		}
	})
}
