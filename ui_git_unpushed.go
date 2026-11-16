//go:build !js

package main

// The commits the upstream branch does not have yet.

import (
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// gitUnpushedDialog lists what is ahead of the upstream; a press opens the
// commit's patch.
func (a *app) gitUnpushedDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		_ = a.gitUnpushedRev.Get()
		_ = a.langRev.Get()
		commits := a.gitUnpushed
		errText := a.gitUnpushedErr.Get()
		var rows []core.Node
		for _, c := range commits {
			c := c
			rows = append(rows, core.View{
				OnPress: func(core.PressEvent) {
					a.gitUnpushedOpen.Set(false)
					a.gitShowCommit(c)
				},
				Role: core.RoleButton, Label: c.Short + " " + c.Subject, TestID: "git-unpushed-row",
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(30),
						Padding: core.Symmetric(0, 6), CornerRadius: 6, Transition: pressMotion,
						Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
				},
				Children: []core.Node{
					ui.Icon(lucide.GitCommitHorizontal, 12, colors.Muted),
					core.Text{Content: c.Short, Style: core.Style{FontFamily: ui.Mono, FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
					core.Text{Content: c.Subject, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11.5},
						StyleFunc: ui.Colored(colors.Text)},
					core.Text{Content: c.Author, MaxLines: 1, Style: core.Style{FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
				}})
		}
		var body core.Node
		switch {
		case errText != "":
			body = core.Text{Content: errText, Style: core.Style{FontSize: 11.5, Padding: core.All(8)}, StyleFunc: ui.Colored(colors.Danger)}
		case len(rows) == 0:
			body = core.Text{Content: T("没有未推送的提交。"), Style: core.Style{FontSize: 11, Padding: core.All(8)},
				StyleFunc: ui.Colored(colors.Faint)}
		default:
			body = core.Scroll{Style: core.Style{MaxHeight: core.Pt(360)}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 1}, Children: rows}}}
		}
		return ui.Dialog{
			Open:         a.gitUnpushedOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.gitUnpushedOpen.Set(open) },
			Title:        T("未推送的提交"),
			Description:  T("这些提交还在本机，推送到上游后才会出现在远端。"),
			TestID:       "git-unpushed",
			Style:        core.Style{Width: core.Pt(720), MaxHeight: core.Pt(520)},
			Children:     []core.Node{body},
			Footer: []core.Node{
				ui.Button{Text: T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "git-unpushed-close",
					OnPress: func() { a.gitUnpushedOpen.Set(false) }},
			},
		}
	})
}
