//go:build !js && !android && !ios

package workbench

// The chat: turns with their tools, the composer, and the empty state.

import (
	"fmt"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// A process group is a run of what pi did inside one message: what it
// reasoned and the calls it made, before or after the prose it said. The
// group heads one line — how much it holds — and its rows wait behind a
// disclosure, so a long turn reads as a few summaries.
//
// The group that is still running opens by itself; every other one stays
// closed until the user opens it, and that choice outlives a rebuild.

// thinkingTone is the identity color of the thinking row: indigo, apart
// from the accent, so the reasoning reads as a process of its own.
func thinkingTone(cx *core.Scope) core.Color {
	if c, ok := cx.Palette().Colors["thinking"]; ok {
		return c
	}
	return ui.ColorsOf(cx).Muted()
}

// processGroup is one run of process rows: what pi thought and the
// calls it made, split at the prose it said in between.
func (a *app) processGroup(s *session, src stepSource, part int) core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		key := fmt.Sprintf("%s/g%d", src.id(), part)
		withThinking := part == 0
		// The prose splits the process in two only when there is some: a
		// message that said nothing keeps its thinking and its calls in one
		// group, as consecutive process entries.
		split := func() bool { return strings.TrimSpace(src.text()) != "" }
		rows := func() []toolRun {
			tools := src.tools()
			from, to := 0, len(tools)
			switch {
			case !split():
				if part != 0 || len(tools) == 0 {
					return nil
				}
			case part == 0:
				to = src.textAt()
			default:
				from = src.textAt()
			}
			start, end := min(max(from, 0), len(tools)), min(max(to, 0), len(tools))
			if start >= end {
				return nil
			}
			return tools[start:end]
		}
		hasThinking := func() bool { return withThinking && strings.TrimSpace(src.thinking()) != "" }
		present := func() bool { return hasThinking() || len(rows()) > 0 }
		// The group holds the turn's live work: it stays open while the
		// step streams or one of its calls still runs, and closes itself
		// once both are done.
		auto := func() bool {
			if src.live() {
				return true
			}
			for _, run := range rows() {
				if run.Status == chat.Running {
					return true
				}
			}
			return false
		}
		open := func() bool {
			s.uiSeq.Get() // redraw when the user opens or closes the group
			return s.procOpen(key, auto())
		}
		title := func() string {
			parts := []string{apptext.T("执行过程")}
			if n := len(rows()); n > 0 {
				parts = append(parts, apptext.T("%d 个工具调用", n))
			}
			if hasThinking() {
				parts = append(parts, apptext.T("思考"))
			}
			return strings.Join(parts, " · ")
		}
		header := base.Button{
			Expanded:  open,
			LabelFunc: title,
			TestID:    fmt.Sprintf("process-%s-%d", src.id(), part),
			OnPress:   func(core.PressEvent) { s.toggleProc(key, auto()) },
			Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Height: core.Pt(26), Gap: 6,
				Padding: core.Symmetric(0, 6), CornerRadius: 6, MinWidth: core.Pt(0)},
			StyleFunc: func() core.Style {
				return core.Style{Hover: &core.Style{Background: colors.Hover()}, FocusVisible: ui.FocusRing(cx, 2)}
			},
			Children: []core.Node{
				ui.IconOf(func() *core.SVG { return lucide.ListTree() }, 13, colors.Faint),
				core.Text{ContentFunc: title, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style:     core.Style{FontSize: 12.5, FontWeight: ui.Medium, MinWidth: core.Pt(0), FlexShrink: 1},
					StyleFunc: ui.Colored(colors.Muted)},
				core.Show{When: auto, Then: func(*core.Scope) core.Node { return ui.Spinner{Size: 10} }},
				ui.IconOf(disclosure(open), 11, colors.Faint),
			},
		}
		body := core.Show{When: func() bool { return open() }, Then: func(cx *core.Scope) core.Node {
			return core.View{Style: core.Style{MinWidth: core.Pt(0), Margin: core.Edges{Left: 6}, Padding: core.Edges{Bottom: 2, Left: 12},
				Borders: core.Edges{Left: 1}, Gap: 4},
				StyleFunc: func() core.Style { return core.Style{BorderColors: core.EdgeColors{Left: colors.Now().Line}} },
				Children: []core.Node{
					core.Show{When: hasThinking, Then: func(cx *core.Scope) core.Node { return a.thinkRow(s, src) }},
					core.Each(rows, func(run toolRun) string { return run.CallID },
						func(cx *core.Scope, run func() toolRun, _ func() int) core.Node { return a.toolRow(s, run) }),
				}}
		}}
		return core.Show{When: present, Then: func(cx *core.Scope) core.Node {
			return core.View{Style: core.Style{MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{header, body}}
		}}
	})
}

// thinkRow is what pi reasoned: one muted line while it is folded, the
// reasoning itself once opened. While it streams the line follows the end,
// so the row reads as the thought in progress.
func (a *app) thinkRow(s *session, src stepSource) core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		key := src.id() + "/think"
		open := func() bool {
			s.uiSeq.Get()
			return s.toolOpen(key, false)
		}
		label := func() string {
			if src.live() {
				return apptext.T("思考中")
			}
			return apptext.T("思考")
		}
		preview := func() string {
			text := src.thinking()
			if src.live() {
				return lastLine(text, 140)
			}
			return shortLine(text, 140)
		}
		rowSize, detailSize := a.readingRowFont(), a.readingDetailFont()
		children := []core.Node{
			ui.Icon(lucide.Brain, 13, func() core.Color { return thinkingTone(cx) }),
			core.Text{ContentFunc: label, MaxLines: 1,
				Style: core.Style{FontSize: rowSize, FontWeight: ui.Medium, FlexShrink: 0}, StyleFunc: ui.Colored(colors.Muted)},
			core.Show{When: open, Then: func(*core.Scope) core.Node { return core.View{Style: core.Style{FlexGrow: 1}} },
				Else: func(*core.Scope) core.Node {
					return core.Text{ContentFunc: preview, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: detailSize,
							LineHeight: a.readingDetailLine()},
						StyleFunc: ui.Colored(colors.Faint)}
				}},
			core.Show{When: src.live, Then: func(*core.Scope) core.Node { return ui.Spinner{Size: 10} }},
			ui.IconOf(disclosure(open), 11, colors.Faint),
		}
		body := []core.Node{
			core.View{OnPress: func(core.PressEvent) { s.toggleOpen(key) }, Role: core.RoleButton, LabelFunc: label,
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinHeight: core.Pt(26),
						Padding: core.Symmetric(0, 4), CornerRadius: 5, Hover: &core.Style{Background: colors.Hover()}}
				},
				Children: children},
			core.Show{When: open, Then: func(cx *core.Scope) core.Node {
				// Long reasoning opens to a window of its own: the group is the
				// summary, and one thought must not push the answer away.
				return core.Scroll{Style: core.Style{MinWidth: core.Pt(0), MaxHeight: core.Pt(320)},
					Children: []core.Node{core.View{Style: core.Style{MinWidth: core.Pt(0), Padding: core.Edges{Left: 19, Top: 2, Bottom: 4}},
						Children: []core.Node{viewkit.MarkdownLive(a.chatSearch, func() string { return src.thinking() }, src.live,
							rowSize, a.readingRowLine(), core.Style{Color: colors.Muted(), FontWeight: core.FontWeight(350)}, a.codeWrap.Get)}}}}
			}},
		}
		return core.View{Style: core.Style{MinWidth: core.Pt(0), Gap: 1}, Children: body}
	})
}

// shortLine is text on one line: its first line, shortened.
func shortLine(text string, width int) string {
	for _, line := range strings.Split(text, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			return shorten(trimmed, width)
		}
	}
	return ""
}

// lastLine is the last line of text a stream is writing, shortened: what
// the reasoning arrived at, not where it started.
func lastLine(text string, width int) string {
	lines := strings.Split(strings.TrimRight(text, " \n"), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if trimmed := strings.TrimSpace(lines[i]); trimmed != "" {
			return shorten(trimmed, width)
		}
	}
	return ""
}
