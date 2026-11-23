//go:build !js && !android && !ios

package workbench

// The chat: turns with their tools, the composer, and the empty state.

import (
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// stepSource reads one assistant message: what it committed, or what pi is
// still streaming into the message that will commit. Each part reads only
// the signals it shows, so a streamed delta repaints the prose and not the
// rows around it.
type stepSource struct {
	s    *session
	turn func() turn
	id   func() string
}

// stepOf finds a committed step by its stable ID.
func stepOf(tt turn, id string) turnStep {
	for i := len(tt.Steps) - 1; i >= 0; i-- {
		if tt.Steps[i].ID == id {
			return tt.Steps[i]
		}
	}
	return turnStep{ID: id}
}

// live reports whether pi is still writing this step.
func (r stepSource) live() bool {
	tt := r.turn()
	return tt.running() && r.id() == stepID(&tt, tt.Msgs)
}

// committed is the step as it was folded in; it is empty while the step is
// the one still streaming.
func (r stepSource) committed() turnStep { return stepOf(r.turn(), r.id()) }

func (r stepSource) thinking() string {
	if r.live() {
		return r.s.streamThinking.Get()
	}
	return r.committed().Thinking
}

func (r stepSource) text() string {
	if r.live() {
		return r.s.streamText.Get()
	}
	return r.committed().Text
}

func (r stepSource) tools() []toolRun {
	if r.live() {
		return r.s.liveTools.Get()
	}
	return r.committed().Tools
}

// textAt is how many calls came before the prose. A streaming step has not
// said yet, so its prose reads above its calls, as pi writes them.
func (r stepSource) textAt() int {
	if r.live() {
		return 0
	}
	st := r.committed()
	return min(max(st.TextAt, 0), len(st.Tools))
}

// turnProcess is a turn's process in the order pi wrote it: what it
// thought and the calls it made, in one group per run of work, split only
// where the turn said something in between.
func (a *app) turnProcess(s *session, t func() turn) core.Node {
	return core.Each(func() []processNode {
		return processNodes(a.processItems(s, t))
	}, func(n processNode) string { return n.id }, func(cx *core.Scope, node func() processNode, _ func() int) core.Node {
		return a.processRow(s, t, node)
	})
}

// processRow is one row of a turn's process: a group of rows behind its
// disclosure, something pi said, or a note.
func (a *app) processRow(s *session, t func() turn, node func() processNode) core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		n := node()
		src := stepSource{s: s, turn: t, id: func() string { return n.step }}
		switch n.kind {
		case processProse:
			return a.chatMarkdownLive(func() string { return src.text() }, src.live, core.Style{})
		case processNote:
			st := src.committed()
			return a.noteBlock(st.Note, st.Text)
		}
		return a.processGroup(s, t, n)
	})
}

// chatMarkdownLive is prose whose text a binding reads: a streaming answer
// updates in place instead of being parsed again as a new view.
func (a *app) chatMarkdownLive(text func() string, live func() bool, tone core.Style) core.Node {
	return viewkit.MarkdownLive(a.chatSearch, text, live, a.readingFont(), a.readingLine(), tone, a.codeWrap.Get)
}

// noteBlock is a system note, such as a compaction summary.
func (a *app) noteBlock(title, body string) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		children := []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7}, Children: []core.Node{
				ui.Icon(lucide.Minimize2, 13, colors.Faint),
				core.Text{Content: title, Style: core.Style{FontSize: a.readingRowFont(), FontWeight: ui.Medium},
					StyleFunc: ui.Colored(colors.Muted)},
			}},
		}
		if body != "" {
			children = append(children, viewkit.MarkdownSized(body, func() bool { return false }, false, a.readingRowFont(), a.readingRowLine(), core.Style{Color: colors.Muted()}))
		}
		return core.View{StyleFunc: func() core.Style {
			return core.Style{Gap: 8, Padding: core.Symmetric(8, 12), CornerRadius: ui.RadiusControl,
				BorderWidth: 1, BorderColor: colors.Border(), Background: colors.Inset()}
		}, Children: children}
	})
}
