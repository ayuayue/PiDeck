//go:build !js && !android && !ios

package workbench

// The chat: turns with their tools, the composer, and the empty state.

import (
	"strings"

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

// turnSteps lists a turn's steps by their stable IDs, and the step pi is
// still streaming after them, so the row that shows it keeps its mount when
// the message commits.
func (a *app) turnSteps(s *session, t func() turn) core.Node {
	return core.Each(func() []string {
		tt := t()
		ids := make([]string, 0, len(tt.Steps)+1)
		for _, st := range tt.Steps {
			ids = append(ids, st.ID)
		}
		if tt.running() {
			ids = append(ids, stepID(&tt, tt.Msgs))
		}
		return ids
	}, func(id string) string { return id }, func(cx *core.Scope, id func() string, _ func() int) core.Node {
		return a.stepRow(s, t, id)
	})
}

// stepRow is one assistant message in the order pi wrote it: its process,
// the prose it said before its last call, and the calls that followed.
func (a *app) stepRow(s *session, t func() turn, id func() string) core.Node {
	src := stepSource{s: s, turn: t, id: id}
	return core.Func(func(cx *core.Scope) core.Node {
		// A note is a system message, such as a compaction summary: it is
		// committed whole and never streams.
		if st := src.committed(); st.Note != "" && !src.live() {
			return a.noteBlock(st.Note, st.Text)
		}
		return core.View{Style: core.Style{MinWidth: core.Pt(0), Gap: 12}, Children: []core.Node{
			a.processGroup(s, src, 0),
			core.Show{When: func() bool { return strings.TrimSpace(src.text()) != "" }, Then: func(cx *core.Scope) core.Node {
				return a.chatMarkdownLive(func() string { return src.text() }, src.live, core.Style{})
			}},
			a.processGroup(s, src, 1),
		}}
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
