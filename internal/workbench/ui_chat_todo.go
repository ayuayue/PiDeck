//go:build !js && !android && !ios

package workbench

// The chat: turns with their tools, the composer, and the empty state.

import (
	"time"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// todoBar is the agent's task list above the composer: a line saying what
// waits that opens to the items. It stays out of the way when there is no
// list, and a dismissed strip stays away until the list changes.
func (a *app) todoBar(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		_ = s.uiSeq.Get()
		colors := ui.ColorsOf(cx)
		items := a.sessionTodos(s)
		if len(items) == 0 {
			return nil
		}
		fingerprint := todoFingerprint(items)
		if s.todoDismissed != "" && s.todoDismissed == fingerprint {
			return nil
		}
		open := s.todoOpen.Get()
		current := currentTodoText(items)
		head := core.View{
			OnPress: func(core.PressEvent) { s.todoOpen.Update(func(v bool) bool { return !v }) },
			Role:    core.RoleButton, Label: apptext.T("待办"), TestID: "todo-bar",
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(32),
					Padding: core.Symmetric(0, 10), CornerRadius: 8, BorderWidth: 1, BorderColor: colors.Border(),
					Background: ui.Alpha(colors.Surface(), 1), Hover: &core.Style{Background: colors.Hover()},
					Transition: viewkit.PressMotion}
			},
			Children: []core.Node{
				ui.Icon(lucide.ListChecks, 13, colors.Muted),
				ui.Text(apptext.T("待办"), 11.5, ui.Medium, colors.Text),
				core.Text{ContentFunc: func() string { return todoProgressText(a.sessionTodos(s)) },
					MaxLines: 1, Style: core.Style{FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
				core.Text{Content: viewkit.FirstLine(current, 60), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11, TextAlign: core.TextAlignEnd},
					StyleFunc: ui.Colored(colors.Muted)},
				ui.IconOf(func() *core.SVG {
					if open {
						return lucide.ChevronDown()
					}
					return lucide.ChevronUp()
				}, 12, colors.Faint),
				// Closing the strip leaves the list with the agent; it comes
				// back when the list changes.
				core.View{OnPress: func(core.PressEvent) {
					s.todoDismissed = todoFingerprint(a.sessionTodos(s))
					a.bumpSessionUI(s)
				}, Role: core.RoleButton, Label: apptext.T("关闭待办"), TestID: "todo-dismiss",
					StyleFunc: func() core.Style {
						return core.Style{Width: core.Pt(20), Height: core.Pt(20), CornerRadius: 5, AlignItems: core.AlignCenter,
							JustifyContent: core.JustifyCenter, Hover: &core.Style{Background: colors.Pressed()}}
					}, Children: []core.Node{ui.Icon(lucide.X, 11, colors.Faint)}},
			},
		}
		if !open {
			return core.View{Style: core.Style{Padding: core.Edges{Bottom: 6}}, Children: []core.Node{head}}
		}
		var rows []core.Node
		for _, it := range items {
			item := it
			icon := lucide.Circle
			tint := colors.Faint
			weight := ui.Regular
			switch item.Status {
			case "completed":
				icon, tint = lucide.CircleCheck, colors.Up
			case "in_progress":
				icon, tint, weight = lucide.Loader, colors.Accent, ui.Medium
			case "cancelled":
				icon, tint = lucide.CircleX, colors.Faint
			}
			rows = append(rows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7,
				MinHeight: core.Pt(24), Padding: core.Edges{Left: 10, Right: 8}}, Children: []core.Node{
				ui.Icon(icon, 12, tint),
				core.Text{Content: item.Text, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11.5, LineHeight: 16},
					StyleFunc: func() core.Style {
						color := colors.Text()
						if item.Status == "completed" || item.Status == "cancelled" {
							color = colors.Faint()
						}
						return core.Style{Color: color, FontWeight: weight}
					}},
			}})
		}
		return core.View{Style: core.Style{Padding: core.Edges{Bottom: 6}, Gap: 3}, Children: []core.Node{
			head,
			core.Scroll{Style: core.Style{MaxHeight: core.Pt(168)}, Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Column, Gap: 1}, Children: rows},
			}},
		}}
	})
}

// streamCaret is the block that pulses at the end of a growing answer.
func streamCaret(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	s := core.Style{Width: core.Pt(7), Height: core.Pt(15), Margin: core.Edges{Left: 2}, CornerRadius: 2}
	if !ui.ReduceMotion(cx) {
		s.Animation = core.KeyframeAnimation{Keyframes: core.KeyframesPulse, Duration: 900 * time.Millisecond}
	}
	return core.View{Style: s, StyleFunc: ui.Filled(colors.Text)}
}
