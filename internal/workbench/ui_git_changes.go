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
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// gitChanges lists the staged and unstaged files.
func (a *app) gitChanges(cx *core.Scope, st gitState) core.Node {
	colors := ui.ColorsOf(cx)
	var staged, unstaged []gitFile
	for _, f := range st.Files {
		if f.staged() {
			staged = append(staged, f)
		}
		if f.unstaged() {
			unstaged = append(unstaged, f)
		}
	}
	row := func(title, count string, actions ...core.Node) core.Node {
		children := []core.Node{
			core.Text{Content: title, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5, LetterSpacing: 0.5}, StyleFunc: ui.Colored(colors.Faint)},
			core.Text{Content: count, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
			core.View{Style: core.Style{FlexGrow: 1}},
		}
		children = append(children, actions...)
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, MinHeight: core.Pt(22)}, Children: children}
	}
	var body []core.Node
	if conflicts := st.conflicts(); len(conflicts) > 0 {
		body = append(body, core.View{
			OnPress: func(core.PressEvent) { a.gitConflictsOpen.Set(true) },
			Role:    core.RoleButton, Label: apptext.T("%d 个文件有冲突", len(conflicts)), TestID: "git-conflicts",
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, MinHeight: core.Pt(30),
					Padding: core.Symmetric(0, 8), CornerRadius: 7, Background: ui.Alpha(colors.Danger(), 0.10),
					BorderWidth: 1, BorderColor: ui.Alpha(colors.Danger(), 0.28), Transition: viewkit.PressMotion,
					Hover: &core.Style{Background: ui.Alpha(colors.Danger(), 0.16)}}
			},
			Children: []core.Node{
				ui.Icon(lucide.TriangleAlert, 12, colors.Danger),
				core.Text{Content: apptext.T("%d 个文件有冲突", len(conflicts)), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 11, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Danger)},
				ui.Text(apptext.T("解决…"), 10.5, ui.Medium, colors.Danger),
			}})
	}
	body = append(body, row(apptext.T("已暂存"), fmt.Sprint(len(staged)),
		a.pressIcon(lucide.Minus, "取消暂存全部", 21, 11,
			func() bool { return len(staged) == 0 || a.git.busy.Get() != "" }, a.gitUnstageAll, "")))
	for _, f := range staged {
		body = append(body, a.gitFileRow(cx, f, true))
	}
	if len(staged) == 0 {
		body = append(body, core.Text{Content: apptext.T("还没有暂存的改动"), Style: core.Style{FontSize: 10.5, Padding: core.Symmetric(3, 6)},
			StyleFunc: ui.Colored(colors.Faint)})
	}
	body = append(body, core.View{Style: core.Style{Height: core.Pt(6)}})
	body = append(body, row(apptext.T("更改"), fmt.Sprint(len(unstaged)),
		a.pressIcon(lucide.Plus, "暂存全部", 21, 11,
			func() bool { return len(unstaged) == 0 || a.git.busy.Get() != "" }, a.gitStageAll, "")))
	for _, f := range unstaged {
		body = append(body, a.gitFileRow(cx, f, false))
	}
	if len(unstaged) == 0 {
		body = append(body, core.Text{Content: apptext.T("工作区干净"), Style: core.Style{FontSize: 10.5, Padding: core.Symmetric(3, 6)},
			StyleFunc: ui.Colored(colors.Faint)})
	}
	return core.View{Style: core.Style{Gap: 1}, Children: body}
}

// gitFileRow is one changed path and its actions.
func (a *app) gitFileRow(cx *core.Scope, f gitFile, staged bool) core.Node {
	colors := ui.ColorsOf(cx)
	tone := gitTone(f, colors)
	name, dir := viewkit.SplitGitPath(f.Path)
	action := func(icon func() *core.SVG, label string, press func(), testID string) core.Node {
		return a.pressIcon(icon, label, 20, 11, func() bool { return a.git.busy.Get() != "" }, press, testID)
	}
	var actions []core.Node
	switch {
	case f.Conflicted:
		// A conflicted path has no "theirs" or "ours" to discard; the
		// dialog offers the three ways out.
		actions = append(actions, action(lucide.GitMerge, "解决冲突 "+name,
			func() { a.gitConflictsOpen.Set(true) }, "git-resolve"))
	case staged:
		actions = append(actions, action(lucide.Minus, "取消暂存 "+name, func() { a.gitUnstageFile(f) }, "git-unstage"))
	default:
		actions = append(actions, action(lucide.Plus, "暂存 "+name, func() { a.gitStageFile(f) }, "git-stage"))
	}
	if !f.Conflicted {
		actions = append(actions, action(lucide.Undo2, "丢弃 "+name, func() { a.gitDiscardFile(f) }, "git-discard"))
	}
	testID := "git-file"
	if staged {
		testID = "git-staged-file"
	}
	return core.View{
		OnPress: func(core.PressEvent) { a.gitShowFileDiff(f, staged) },
		Role:    core.RoleButton, Label: f.Path, TestID: testID,
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinHeight: core.Pt(35),
				Padding: core.Edges{Left: 4, Right: 2}, CornerRadius: 6, Transition: viewkit.PressMotion,
				Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{
			core.View{Style: core.Style{Width: core.Pt(16), Height: core.Pt(16), CornerRadius: 4, AlignItems: core.AlignCenter,
				JustifyContent: core.JustifyCenter, Background: ui.Alpha(tone, 0.13), FlexShrink: 0},
				Children: []core.Node{ui.Text(f.mark(), 9, ui.Semibold, func() core.Color { return tone })}},
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 0}, Children: []core.Node{
				core.Text{Content: name, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
					Style: core.Style{FontSize: 11.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Text)},
				core.Show{When: func() bool { return dir != "" }, Then: func(cx *core.Scope) core.Node {
					return core.Text{Content: dir, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9, LineHeight: 12}, StyleFunc: ui.Colored(colors.Faint)}
				}},
			}},
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 0, FlexShrink: 0}, Children: actions},
		},
	}
}
