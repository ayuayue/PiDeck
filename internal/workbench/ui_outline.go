//go:build !js && !android && !ios

package workbench

// The session outline: one row per prompt, a press jumps to that turn.

import (
	"fmt"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// jumpToTurnIndex scrolls the transcript to a turn's place in it.
func (a *app) jumpToTurnIndex(s *session, i int) {
	if s == nil {
		return
	}
	turns := s.turns.GetUntracked()
	n := len(turns)
	if i < 0 || i >= n {
		return
	}
	// Where the turn was last laid out is where the jump should land; until
	// it has been, its share of the length is the best guess there is.
	if y, ok := s.tops[turns[i].ID]; ok {
		a.scrollToOffset(s, y)
		return
	}
	a.jumpToTurn(s, float64(i)/float64(max(1, n-1)))
}

// outlineDialog lists a session's prompts.
func (a *app) outlineDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		_ = a.langRev.Get()
		s := a.active()
		var turns []turn
		if s != nil {
			turns = s.turns.Get()
		}
		var rows []core.Node
		for i, t := range turns {
			i, t := i, t
			label := viewkit.FirstLine(t.Prompt, 90)
			if label == "" {
				label = apptext.T("（没有文字）")
			}
			rows = append(rows, core.View{
				OnPress: func(core.PressEvent) {
					a.outlineOpen.Set(false)
					a.jumpToTurnIndex(s, i)
				},
				Role: core.RoleButton, Label: label, TestID: "outline-row",
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(30),
						Padding: core.Symmetric(0, 6), CornerRadius: 6, Transition: viewkit.PressMotion,
						Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
				},
				Children: []core.Node{
					core.Text{Content: fmt.Sprint(i + 1), Style: core.Style{Width: core.Pt(28), TextAlign: core.TextAlignEnd,
						FontFamily: viewkit.MonoFont(), FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
					ui.Icon(lucide.MessageSquare, 11, colors.Faint),
					core.Text{Content: label, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12},
						StyleFunc: ui.Colored(colors.Text)},
					core.Show{When: func() bool { return !t.Start.IsZero() }, Then: func(*core.Scope) core.Node {
						return core.Text{Content: t.Start.Format("15:04"), Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5},
							StyleFunc: ui.Colored(colors.Faint)}
					}},
				}})
		}
		var body core.Node
		if len(rows) == 0 {
			body = core.Text{Content: apptext.T("这个会话还没有内容。"), Style: core.Style{FontSize: 11, Padding: core.All(8)},
				StyleFunc: ui.Colored(colors.Faint)}
		} else {
			body = core.Scroll{Style: core.Style{MaxHeight: core.Pt(440)}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 1}, Children: rows}}}
		}
		return ui.Dialog{
			Open:         a.outlineOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.outlineOpen.Set(open) },
			Title:        apptext.T("会话大纲"),
			Description:  apptext.T("每个提问一条；点一下跳到那一轮。"),
			TestID:       "outline-dialog",
			Style:        core.Style{Width: a.dialogWidth(), MaxHeight: core.Pt(560)},
			Children:     []core.Node{body},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.outlineOpen.Set(false) }},
			},
		}
	})
}
