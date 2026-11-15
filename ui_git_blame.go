package main

// Who last touched each run of lines in a file.

import (
	"fmt"

	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// gitBlameDialog lists a file's line ranges by commit; a press opens the
// commit's patch.
func (a *app) gitBlameDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		_ = a.gitBlameRev.Get()
		_ = a.langRev.Get()
		ranges := a.gitBlame
		errText := a.gitBlameErr.Get()
		var rows []core.Node
		for _, b := range ranges {
			b := b
			span := fmt.Sprintf("%d", b.Start)
			if b.End > b.Start {
				span = fmt.Sprintf("%d–%d", b.Start, b.End)
			}
			commit := gitCommit{Hash: b.Hash, Short: b.short(), Author: b.Author, Subject: b.Subject, Date: b.When}
			rows = append(rows, core.View{
				OnPress: func(core.PressEvent) {
					a.gitBlameOpen.Set(false)
					a.gitShowCommit(commit)
				},
				Role: core.RoleButton, Label: span + " " + b.Subject, TestID: "blame-row",
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(30),
						Padding: core.Symmetric(0, 6), CornerRadius: 6, Transition: pressMotion,
						Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
				},
				Children: []core.Node{
					core.Text{Content: span, Style: core.Style{Width: core.Pt(64), TextAlign: core.TextAlignEnd,
						FontFamily: ui.Mono, FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
					ui.Icon(lucide.GitCommitHorizontal, 11, colors.Faint),
					core.Text{Content: b.short(), Style: core.Style{FontFamily: ui.Mono, FontSize: 10}, StyleFunc: ui.Colored(colors.Muted)},
					core.Text{Content: b.Subject, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11.5},
						StyleFunc: ui.Colored(colors.Text)},
					core.Show{When: func() bool { return !b.When.IsZero() }, Then: func(*core.Scope) core.Node {
						return core.Text{Content: b.When.Format("2006-01-02"), Style: core.Style{FontSize: 9.5},
							StyleFunc: ui.Colored(colors.Faint)}
					}},
					core.Text{Content: b.Author, MaxLines: 1, Style: core.Style{FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
				}})
		}
		var body core.Node
		switch {
		case errText != "":
			body = core.Text{Content: errText, Style: core.Style{FontSize: 11.5, Padding: core.All(8)}, StyleFunc: ui.Colored(colors.Danger)}
		case len(rows) == 0:
			body = core.Text{Content: T("这个文件还没有提交记录。"), Style: core.Style{FontSize: 11, Padding: core.All(8)},
				StyleFunc: ui.Colored(colors.Faint)}
		default:
			body = core.Scroll{Style: core.Style{MaxHeight: core.Pt(420)}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 1}, Children: rows}}}
		}
		return ui.Dialog{
			Open:         a.gitBlameOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.gitBlameOpen.Set(open) },
			Title:        T("追溯"),
			Description:  a.gitBlamePath.Get(),
			TestID:       "git-blame",
			Style:        core.Style{Width: core.Pt(780), MaxHeight: core.Pt(560)},
			Children:     []core.Node{body},
			Footer: []core.Node{
				ui.Button{Text: T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.gitBlameOpen.Set(false) }},
			},
		}
	})
}
