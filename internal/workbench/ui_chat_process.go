//go:build !js && !android && !ios

package workbench

// The chat: what one turn did, as process groups split by what it said.

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

// A turn's process is a run of blocks — what pi thought and the calls it
// made inside one message — split only where the turn said something in
// between. A group heads one line, how much it holds, and its rows wait
// behind a disclosure, so a long turn reads as a few summaries instead of
// one summary per message.
//
// The group that is still running opens by itself; every other one stays
// closed until the user opens it, and that choice outlives a rebuild.

// processKind says what one node of a turn's process is.
type processKind int

const (
	// processBlock is what one message did: the thinking and the calls
	// before the prose it said, or the calls after it.
	processBlock processKind = iota
	// processProse is something pi said between two runs of process.
	processProse
	// processNote is a system note, such as a compaction summary: it is
	// committed whole and never streams.
	processNote
	// processGroup is a run of blocks between two things said.
	processGroup
)

// processItem is one node of a turn's process, in the order pi wrote it.
type processItem struct {
	id   string
	step string // the message it belongs to
	kind processKind
	part int // the block that did the thinking (0), or the calls after the prose (1)
}

// processNode is one row of a turn's process: a group of the blocks pi
// worked through between two things it said, or one thing it said.
type processNode struct {
	id      string
	step    string
	kind    processKind
	members []processItem // a group's blocks, in order
}

// processItems is what a turn shows in process order: each message's
// blocks and the prose it said, as pi wrote them. A message that said
// nothing keeps its thinking and its calls in one block, so it does not
// split the run around it.
func (a *app) processItems(s *session, t func() turn) []processItem {
	tt := t()
	live := ""
	if tt.running() {
		live = stepID(&tt, tt.Msgs)
	}
	items := make([]processItem, 0, 2*len(tt.Steps)+3)
	for _, st := range tt.Steps {
		items = append(items, blockItem(st.ID, 0))
		switch {
		case st.Note != "":
			items[len(items)-1] = processItem{id: st.ID, step: st.ID, kind: processNote}
		case strings.TrimSpace(st.Text) != "":
			items = append(items, sayItem(st.ID), blockItem(st.ID, 1))
		}
	}
	if live != "" {
		// The streaming message has not said yet where its prose goes: its
		// prose reads above its calls, and the committed message puts the
		// calls back in order.
		items = append(items, blockItem(live, 0), sayItem(live), blockItem(live, 1))
	}
	return items
}

func blockItem(step string, part int) processItem {
	return processItem{id: fmt.Sprintf("%s/p%d", step, part), step: step, kind: processBlock, part: part}
}

func sayItem(step string) processItem {
	return processItem{id: step + "/say", step: step, kind: processProse}
}

// processNodes collects a turn's items into the rows it shows: a run of
// blocks becomes one group, and a message that said something — or a note
// — ends the run there and stands as a row of its own.
func processNodes(items []processItem) []processNode {
	nodes := make([]processNode, 0, len(items))
	var run []processItem
	flush := func() {
		if len(run) == 0 {
			return
		}
		nodes = append(nodes, processNode{id: "g:" + run[0].id, step: run[0].step, kind: processGroup, members: run})
		run = nil
	}
	for _, item := range items {
		if item.kind == processBlock {
			run = append(run, item)
			continue
		}
		flush()
		nodes = append(nodes, processNode{id: item.id, step: item.step, kind: item.kind})
	}
	flush()
	return nodes
}

// blockRuns is the calls one message's block made: those before the prose
// it said, the ones after it, or all of them when it said nothing.
func blockRuns(src stepSource, part int) []toolRun {
	tools := src.tools()
	if strings.TrimSpace(src.text()) == "" {
		if part == 0 {
			return tools
		}
		return nil
	}
	at := min(max(src.textAt(), 0), len(tools))
	if part == 0 {
		return tools[:at]
	}
	return tools[at:]
}

// thinkingTone is the identity color of the thinking row: indigo, apart
// from the accent, so the reasoning reads as a process of its own.
func thinkingTone(cx *core.Scope) core.Color {
	if c, ok := cx.Palette().Colors["thinking"]; ok {
		return c
	}
	return ui.ColorsOf(cx).Muted()
}

// processGroup is one run of process rows: what pi thought and the calls
// it made between two things it said.
func (a *app) processGroup(s *session, t func() turn, node processNode) core.Node {
	members := node.members
	src := func(m processItem) stepSource {
		return stepSource{s: s, turn: t, id: func() string { return m.step }}
	}
	return core.Func(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		key := s.ID + "/" + node.id
		hasThinking := func() bool {
			for _, m := range members {
				if m.part == 0 && strings.TrimSpace(src(m).thinking()) != "" {
					return true
				}
			}
			return false
		}
		rows := func() []toolRun {
			var runs []toolRun
			for _, m := range members {
				runs = append(runs, blockRuns(src(m), m.part)...)
			}
			return runs
		}
		present := func() bool { return hasThinking() || len(rows()) > 0 }
		// The group holds the turn's live work: it stays open while one of
		// its messages streams or one of its calls still runs, and closes
		// itself once both are done.
		auto := func() bool {
			for _, m := range members {
				if src(m).live() {
					return true
				}
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
			TestID:    fmt.Sprintf("process-%s", node.id),
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
		body := core.Show{When: open, Then: func(cx *core.Scope) core.Node {
			return core.View{Style: core.Style{MinWidth: core.Pt(0), Margin: core.Edges{Left: 6}, Padding: core.Edges{Bottom: 2, Left: 12},
				Borders: core.Edges{Left: 1}, Gap: 4},
				StyleFunc: func() core.Style { return core.Style{BorderColors: core.EdgeColors{Left: colors.Now().Line}} },
				Children: []core.Node{
					core.Each(func() []processItem { return members },
						func(m processItem) string { return m.id },
						func(cx *core.Scope, m func() processItem, _ func() int) core.Node {
							return a.memberRows(s, t, m)
						}),
				}}
		}}
		return core.Show{When: present, Then: func(cx *core.Scope) core.Node {
			return core.View{Style: core.Style{MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{header, body}}
		}}
	})
}

// memberRows is one message's block inside a group: what it reasoned in
// the block that did the thinking, then the calls it made there.
func (a *app) memberRows(s *session, t func() turn, m func() processItem) core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		item := m()
		src := stepSource{s: s, turn: t, id: func() string { return item.step }}
		rows := func() []toolRun { return blockRuns(src, item.part) }
		return core.Group{
			core.Show{When: func() bool { return item.part == 0 && strings.TrimSpace(src.thinking()) != "" },
				Then: func(cx *core.Scope) core.Node { return a.thinkRow(s, src) }},
			core.Each(rows, func(run toolRun) string { return run.CallID },
				func(cx *core.Scope, run func() toolRun, _ func() int) core.Node { return a.toolRow(s, run) }),
		}
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
