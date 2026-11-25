//go:build !js && !android && !ios

package workbench

// The chat: turns with their tools, the composer, and the empty state.

import (
	"strings"
	"unicode/utf8"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
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
		// The turn's newest group is the one it is working in: it stays open
		// while the turn runs, and closes once the turn is done or a later
		// group took over, as Electron's auto slot does. A group holding
		// nothing yet — the trailing block of a message that has not spoken —
		// is no row, so it does not take the slot from the real one.
		latest := core.NewMemo(cx, func() bool {
			list := processNodes(a.processItems(s, t))
			for i := len(list) - 1; i >= 0; i-- {
				if list[i].kind == processGroup && groupPresent(s, t, list[i]) {
					return list[i].id == n.id
				}
			}
			return false
		}).Get
		src := stepSource{s: s, turn: t, id: func() string { return n.step }}
		switch n.kind {
		case processProse:
			return a.chatMarkdownLive(func() string { return src.text() }, src.live, core.Style{})
		case processNote:
			return a.noteBlock(s, func() turnStep { return src.committed() }, func() chat.Status { return src.turn().Status })
		}
		return a.processGroup(s, t, n, latest)
	})
}

// processBodyMax bounds an open group's rows: a long run stays a window of
// its own, as Electron's min(640px, 60vh), so one group cannot push the
// answer below it out of sight.
func processBodyMax(cx *core.Scope) core.Points {
	return core.Points(min(640, cx.Env().Window().Height*0.6))
}

// chatMarkdownLive is prose whose text a binding reads: a streaming answer
// updates in place instead of being parsed again as a new view.
func (a *app) chatMarkdownLive(text func() string, live func() bool, tone core.Style) core.Node {
	return viewkit.MarkdownLive(a.chatSearch, text, live, a.readingFont(), a.readingLine(), tone, a.codeWrap.Get)
}

// noteBlock is a system note, such as a compaction summary.
func (a *app) noteBlock(s *session, step func() turnStep, status func() chat.Status) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		state := status()
		st := step()
		key := s.ID + "/note/" + st.ID
		s.uiSeq.Get()
		open := s.foldOpen(key, false)
		preview, foldable := notePreview(st.Text)
		if open {
			preview = st.Text
		}
		icon := lucide.Minimize2
		ink := colors.Faint
		switch state {
		case chat.Running, chat.Waiting:
			icon, ink = lucide.LoaderCircle, colors.Info
		case chat.Completed:
			icon, ink = lucide.CircleCheck, colors.Up
		case chat.Failed:
			icon, ink = lucide.CircleAlert, colors.Danger
		case chat.Cancelled:
			icon, ink = lucide.CircleX, colors.Faint
		}
		children := []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7}, Children: []core.Node{
				ui.Icon(icon, 13, ink),
				core.Text{Content: st.Note, Style: core.Style{FontSize: a.readingRowFont(), FontWeight: ui.Medium},
					StyleFunc: ui.Colored(colors.Muted)},
				ui.Text(statusLabel(state), 10, ui.Medium, ink),
			}},
			viewkit.MarkdownLive(a.chatSearch, func() string { return preview }, func() bool { return false },
				a.readingRowFont(), a.readingRowLine(), core.Style{Color: colors.Muted()}, a.codeWrap.Get),
		}
		if foldable {
			label, chevron := apptext.T("展开全文（%d 字）", utf8.RuneCountInString(st.Text)), lucide.ChevronDown
			if open {
				label, chevron = apptext.T("收起"), lucide.ChevronUp
			}
			children = append(children, core.View{Style: core.Style{Direction: core.Row}, Children: []core.Node{
				ui.Button{TestID: "note-toggle-" + st.ID, Text: label, Icon: chevron, Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { s.toggleFold(key, false) }},
			}})
		}
		return core.View{TestID: "note-card", StyleFunc: func() core.Style {
			return core.Style{Gap: 8, Padding: core.Symmetric(8, 12), CornerRadius: ui.RadiusControl,
				BorderWidth: 1, BorderColor: colors.Border(), Background: colors.Inset()}
		}, Children: children}
	})
}

// notePreview bounds both a single long paragraph and a many-line summary.
func notePreview(text string) (string, bool) {
	chars, lines := 0, 1
	for i, r := range text {
		if chars == 600 || (r == '\n' && lines == 6) {
			if strings.TrimSpace(text[i:]) == "" {
				return text, false
			}
			return strings.TrimRight(text[:i], " \t\r\n") + "…", true
		}
		chars++
		if r == '\n' {
			lines++
		}
	}
	return text, false
}
