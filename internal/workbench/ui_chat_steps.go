//go:build !js && !android && !ios

package workbench

// The chat: turns with their tools, the composer, and the empty state.

import (
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// steps is a turn's work: one step per assistant message, streaming or
// committed. The step an answer streams into keeps its ID when it commits,
// so the same row becomes the finished one instead of being rebuilt.
func (a *app) steps(s *session, tt turn) []chat.Step {
	out := make([]chat.Step, 0, len(tt.Steps)+1)
	for _, st := range tt.Steps {
		out = append(out, a.stepView(s, tt, st, false))
	}
	if tt.running() {
		out = append(out, a.stepView(s, tt, turnStep{ID: stepID(&tt, tt.Msgs), Start: tt.Start}, true))
	}
	return out
}

// stepView is one assistant message: what it thought, what it ran, what it
// said.
func (a *app) stepView(s *session, tt turn, st turnStep, live bool) chat.Step {
	return chat.Step{ID: st.ID, Message: func(cx *core.Scope) core.Node {
		return core.Dynamic(func(cx *core.Scope) core.Node {
			var children []core.Node
			thinking, tools := st.Thinking, st.Tools
			text := st.Text
			if live {
				thinking = s.streamThinking.Get()
				tools = s.liveTools.Get()
				text = s.streamText.Get()
			}
			if st.Note != "" {
				children = append(children, a.noteBlock(st.Note, st.Text))
			}
			if strings.TrimSpace(thinking) != "" {
				children = append(children, a.thinkRow(s, st, thinking, live))
			}
			if len(tools) > 0 {
				children = append(children, a.toolRows(s, tools))
			}
			if text != "" {
				children = append(children, viewkit.MarkdownSearch(a.chatSearch, text, func() bool { return live }, live, a.readingFont(), a.readingLine(), core.Style{}))
			}
			if len(children) == 0 {
				return nil
			}
			return core.View{Style: core.Style{Gap: 12, MinWidth: core.Pt(0)}, Children: children}
		})
	}}
}

// thinkingReveal is how much of a long thinking row shows before its rest
// is asked for: a screenful of reasoning, not the whole of it.
const thinkingReveal = 1_500

// thinkingTone is the identity color of the thinking row: indigo, apart
// from the accent, so the reasoning reads as a process of its own.
func thinkingTone(cx *core.Scope) core.Color {
	if c, ok := cx.Palette().Colors["thinking"]; ok {
		return c
	}
	return ui.ColorsOf(cx).Muted()
}

// thinkRow is what pi reasoned, folded to one line until opened. It sits a
// step below the answer: row-sized text in the muted ink, a mono preview
// for the folded line, and the duration in the faint detail size. While it
// streams it stays open and counts.
func (a *app) thinkRow(s *session, st turnStep, thinking string, live bool) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		s.uiSeq.Get() // redraw when a row opens or closes
		key := s.ID + "/think/" + st.ID
		open := s.thinkingRowOpen(key, live)
		started := st.Start
		if started.IsZero() {
			started = a.cx.Now()
		}
		label := "思考"
		if live {
			label = "思考中"
		}
		rowSize, detailSize := a.readingRowFont(), a.readingDetailFont()
		header := []core.Node{
			ui.Icon(lucide.Brain, 13, func() core.Color { return thinkingTone(cx) }),
			core.Text{Content: label, MaxLines: 1,
				Style: core.Style{FontSize: rowSize, FontWeight: ui.Medium, FlexShrink: 0}, StyleFunc: ui.Colored(colors.Muted)},
		}
		if live {
			header = append(header, ui.Tabular(core.Text{Content: "· " + duration(a.cx.Now().Sub(started)), MaxLines: 1,
				Style: core.Style{FontSize: detailSize, FlexShrink: 0}, StyleFunc: ui.Colored(colors.Faint)}))
		}
		header = append(header, ui.IconOf(func() *core.SVG {
			if open {
				return lucide.ChevronDown()
			}
			return lucide.ChevronRight()
		}, 11.5, colors.Faint))
		if open {
			header = append(header, core.View{Style: core.Style{FlexGrow: 1}})
		} else {
			header = append(header, core.Text{Content: shorten(thinking, 160), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: detailSize,
					LineHeight: a.readingDetailLine(), FontFamily: viewkit.MonoFont()},
				StyleFunc: ui.Colored(colors.Faint)})
		}
		if live {
			header = append(header, ui.Spinner{Size: 10})
		}
		body := []core.Node{core.View{
			OnPress: func(core.PressEvent) { s.toggleThink(key, live) },
			Role:    core.RoleButton, Label: label,
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinHeight: core.Pt(26), Padding: core.Symmetric(0, 2),
					Hover: &core.Style{Background: colors.Hover()}, CornerRadius: 5}
			},
			Children: header,
		}}
		if open {
			// Long reasoning opens to its head, so reading one thought does
			// not push the answer off the page; the rest is one press away.
			shown, more := viewkit.Reveal(thinking, thinkingReveal)
			all := live || s.thinkShowsAll(key)
			if all {
				shown, more = thinking, false
			}
			rows := []core.Node{
				viewkit.MarkdownSearch(a.chatSearch, shown, func() bool { return live }, false, rowSize, a.readingRowLine(),
					core.Style{Color: colors.Muted(), FontWeight: core.FontWeight(350)}),
			}
			if more {
				left := viewkit.LeftOver(thinking, shown)
				rows = append(rows, core.View{OnPress: func(core.PressEvent) { s.toggleThinkFull(key) },
					Role: core.RoleButton, Label: apptext.T("展开其余"), TestID: "chat-think-more",
					StyleFunc: func() core.Style {
						return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, MinHeight: core.Pt(22),
							Padding: core.Symmetric(0, 2), CornerRadius: 5, Hover: &core.Style{Background: colors.Hover()}}
					}, Children: []core.Node{
						ui.Text(apptext.T("展开其余（还有 %d 字）", left), 10.5, ui.Medium, colors.Muted),
						ui.Icon(lucide.ChevronDown, 11, colors.Faint),
					}})
			}
			body = append(body, core.View{Style: core.Style{MinWidth: core.Pt(0), Margin: core.Edges{Left: 18},
				Padding: core.Edges{Left: 12, Top: 4, Bottom: 2}, Borders: core.Edges{Left: 2},
				BorderColors: core.EdgeColors{Left: colors.Now().Line}, Gap: 2}, Children: rows})
		}
		return core.View{Style: core.Style{MinWidth: core.Pt(0), Gap: 2}, Children: body}
	})
}

// toolRows is a message's tool calls in the order it made them.
func (a *app) toolRows(s *session, tools []toolRun) core.Node {
	rows := make([]core.Node, 0, len(tools))
	for _, run := range tools {
		rows = append(rows, a.toolRow(s, run))
	}
	return core.View{Style: core.Style{Gap: 6, MinWidth: core.Pt(0)}, Children: rows}
}
