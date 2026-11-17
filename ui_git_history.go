//go:build !js && !android && !ios

package main

// The commits that touched one file.

import (
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// gitFileHistoryDialog lists a file's commits; a press opens its patch.
func (a *app) gitFileHistoryDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		_ = a.gitFileHistoryRev.Get()
		_ = a.langRev.Get()
		commits := a.gitFileHistory
		errText := a.gitFileHistoryErr.Get()
		var rows []core.Node
		for _, c := range commits {
			c := c
			rows = append(rows, core.View{
				OnPress: func(core.PressEvent) {
					a.gitFileHistoryOpen.Set(false)
					a.gitShowCommit(c)
				},
				Role: core.RoleButton, Label: c.Short + " " + c.Subject, TestID: "git-history-row",
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(32),
						Padding: core.Symmetric(0, 6), CornerRadius: 6, Transition: pressMotion,
						Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
				},
				Children: []core.Node{
					ui.Icon(lucide.GitCommitHorizontal, 12, colors.Muted),
					core.Text{Content: c.Short, Style: core.Style{FontFamily: monoFont(), FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
					core.Text{Content: c.Subject, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11.5},
						StyleFunc: ui.Colored(colors.Text)},
					core.Text{Content: c.Author, MaxLines: 1, Style: core.Style{FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
					core.Text{Content: c.Date.Format("2006-01-02"), Style: core.Style{FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
				}})
		}
		var body core.Node
		switch {
		case errText != "":
			body = core.Text{Content: errText, Style: core.Style{FontSize: 11.5, Padding: core.All(8)}, StyleFunc: ui.Colored(colors.Danger)}
		case len(rows) == 0:
			body = core.Text{Content: T("还没有改过这个文件。"), Style: core.Style{FontSize: 11, Padding: core.All(8)},
				StyleFunc: ui.Colored(colors.Faint)}
		default:
			body = core.Scroll{Style: core.Style{MaxHeight: core.Pt(400)}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 1}, Children: rows}}}
		}
		return ui.Dialog{
			Open:         a.gitFileHistoryOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.gitFileHistoryOpen.Set(open) },
			Title:        T("文件历史"),
			Description:  a.gitFileHistoryPath.Get(),
			TestID:       "git-file-history-dialog",
			Style:        core.Style{Width: core.Pt(760), MaxHeight: core.Pt(560)},
			Children:     []core.Node{body},
			Footer: []core.Node{
				ui.Button{Text: T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "git-history-close",
					OnPress: func() { a.gitFileHistoryOpen.Set(false) }},
			},
		}
	})
}
