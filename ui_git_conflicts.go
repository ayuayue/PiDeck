package main

// Resolving a merge's conflicts: keep one side, or stage the file as it is.

import (
	"fmt"

	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// gitConflictsDialog lists the conflicted paths with the three ways out.
func (a *app) gitConflictsDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		conflicts := a.git.state.Get().conflicts()
		busy := func() bool { return a.git.busy.Get() != "" }
		var rows []core.Node
		for i, f := range conflicts {
			i, f := i, f
			name, dir := splitGitPath(f.Path)
			button := func(text string, primary bool, press func(), testID string) core.Node {
				variant := ui.ButtonSecondary
				if primary {
					variant = ui.ButtonPrimary
				}
				return ui.Button{Text: text, Variant: variant, Size: ui.SizeSmall, TestID: testID, Disabled: busy, OnPress: press}
			}
			rows = append(rows, core.View{TestID: fmt.Sprintf("git-conflict-%d", i),
				Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(40),
					Padding: core.Symmetric(4, 6)},
				Children: []core.Node{
					core.View{Style: core.Style{Width: core.Pt(16), Height: core.Pt(16), CornerRadius: 4, FlexShrink: 0,
						AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Background: ui.Alpha(colors.Danger(), 0.13)},
						Children: []core.Node{ui.Text("U", 9, ui.Semibold, colors.Danger)}},
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 0}, Children: []core.Node{
						core.Text{Content: name, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style: core.Style{FontSize: 11.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Text)},
						core.Show{When: func() bool { return dir != "" }, Then: func(*core.Scope) core.Node {
							return core.Text{Content: dir, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
								Style: core.Style{FontFamily: ui.Mono, FontSize: 9, LineHeight: 12}, StyleFunc: ui.Colored(colors.Faint)}
						}},
					}},
					button(T("用我的版本"), false, func() { a.gitResolveConflict(f, "ours") }, fmt.Sprintf("git-ours-%d", i)),
					button(T("用对方版本"), false, func() { a.gitResolveConflict(f, "theirs") }, fmt.Sprintf("git-theirs-%d", i)),
					button(T("标记已解决"), true, func() { a.gitMarkResolved(f) }, fmt.Sprintf("git-resolved-%d", i)),
				}})
		}
		if len(rows) == 0 {
			rows = append(rows, core.Text{Content: T("没有需要解决的冲突。"), Style: core.Style{FontSize: 11, Padding: core.All(8)},
				StyleFunc: ui.Colored(colors.Faint)})
		}
		return ui.Dialog{
			Open:         a.gitConflictsOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.gitConflictsOpen.Set(open) },
			Title:        T("解决冲突"),
			Description:  T("选择保留哪一边，或手动改好后标记为已解决。"),
			TestID:       "git-conflicts-dialog",
			Style:        core.Style{Width: core.Pt(720), MaxHeight: core.Pt(560)},
			Children: []core.Node{core.Scroll{Style: core.Style{MaxHeight: core.Pt(380)}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 2}, Children: rows}}}},
			Footer: []core.Node{
				ui.Button{Text: T("中止合并…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "git-abort-merge",
					Disabled: busy, OnPress: a.gitAbortOperation},
				core.View{Style: core.Style{FlexGrow: 1}},
				ui.Button{Text: T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "git-conflicts-close",
					OnPress: func() { a.gitConflictsOpen.Set(false) }},
			},
		}
	})
}
