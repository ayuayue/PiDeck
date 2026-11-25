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
		// calls back in order. A stream that has said nothing yet splits
		// nothing: it holds the newest group open instead of breaking the run
		// in two, and the block after the prose is no row until there is prose.
		items = append(items, blockItem(live, 0))
		if strings.TrimSpace(s.streamText.Get()) != "" {
			items = append(items, sayItem(live), blockItem(live, 1))
		}
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

// groupThinking is how many messages in a group reasoned before they called
// anything: one thought per message that has one, as Electron counts its
// thinking steps.
func groupThinking(s *session, t func() turn, node processNode) int {
	n := 0
	for _, m := range node.members {
		if m.part != 0 {
			continue
		}
		src := stepSource{s: s, turn: t, id: func() string { return m.step }}
		if strings.TrimSpace(src.thinking()) != "" {
			n++
		}
	}
	return n
}

// groupActive is what a group is doing now: the row it holds that is still
// running, or the thought pi is still writing. Everything else in the group
// is done, so a group with nothing live reports nothing: the header then
// keeps its counts only.
func groupActive(s *session, t func() turn, node processNode) (run toolRun, thinking bool, ok bool) {
	for i := len(node.members) - 1; i >= 0; i-- {
		m := node.members[i]
		src := stepSource{s: s, turn: t, id: func() string { return m.step }}
		runs := blockRuns(src, m.part)
		for j := len(runs) - 1; j >= 0; j-- {
			if runs[j].Status == chat.Running {
				return runs[j], false, true
			}
		}
		// A thought being written is the live message's stream: a committed
		// one has finished thinking, and its reasoning reads as a done row.
		if m.part == 0 && strings.TrimSpace(src.thinking()) != "" {
			return toolRun{}, true, true
		}
	}
	return toolRun{}, false, false
}

// activeText is what the turn is doing in this group now, in words of its
// own: the counts say how much, this says whether pi is thinking or which
// tool it is running.
func activeTextOf(s *session, t func() turn, node processNode) string {
	run, thinking, ok := groupActive(s, t, node)
	switch {
	case !ok:
		return ""
	case thinking:
		return apptext.T("正在思考")
	}
	detail := shorten(run.Detail, 60)
	phrase := runningPhrase(run.Action)
	if detail != "" {
		return phrase + " " + detail
	}
	return phrase
}

// runningPhrase says a tool's action as it happens. The action labels the
// row uses are nouns (运行 is a runtime elsewhere), so each one has a
// phrase of its own; an unknown tool — its name is its action — falls back
// to the generic one.
func runningPhrase(action string) string {
	switch action {
	case "读取":
		return apptext.T("正在读取文件")
	case "写入":
		return apptext.T("正在写入文件")
	case "编辑":
		return apptext.T("正在编辑文件")
	case "运行":
		return apptext.T("正在运行命令")
	case "列目录":
		return apptext.T("正在列出目录")
	case "查找", "搜索":
		return apptext.T("正在搜索")
	case "联网搜索":
		return apptext.T("正在联网搜索")
	case "抓取":
		return apptext.T("正在抓取网页")
	case "子代理", "工作流":
		return apptext.T("正在协调子代理")
	}
	return apptext.T("正在调用工具")
}

// groupPresent reports whether a group holds anything to show: thinking or
// a call. A block of a message that has not said anything yet holds
// neither, so it is no row at all.
func groupPresent(s *session, t func() turn, node processNode) bool {
	for _, m := range node.members {
		src := stepSource{s: s, turn: t, id: func() string { return m.step }}
		if m.part == 0 && strings.TrimSpace(src.thinking()) != "" {
			return true
		}
		if len(blockRuns(src, m.part)) > 0 {
			return true
		}
	}
	return false
}

// thinkingTone is the identity color of the thinking row: indigo, apart
// from the accent, so the reasoning reads as a process of its own.
func thinkingTone(cx *core.Scope) core.Color {
	if c, ok := cx.Palette().Colors["thinking"]; ok {
		return c
	}
	return ui.ColorsOf(cx).Muted()
}

// processFollow keeps one open group's body on its newest row: the rows a
// turn is still writing land at the end of a window they overflow, and a
// reader who scrolled back up to an earlier one keeps their place.
type processFollow struct {
	ref       core.Ref
	following bool
	lastY     core.Points
}

// reset starts a body that just mounted on its newest row: the scroll view
// is new, so where the last one stood says nothing about this one.
func (f *processFollow) reset() {
	f.following = true
	f.lastY = 0
}

// scrolled follows the reader: moving up leaves the newest row, and
// reaching it follows again. A scroll the app asked for is not the reader
// moving.
func (f *processFollow) scrolled(e core.ScrollEvent) {
	if e.Stale {
		return
	}
	end := e.Offset.Y+e.Size.Height >= e.ContentSize.Height-2
	switch {
	case end:
		f.following = true
	case e.Offset.Y < f.lastY-1:
		f.following = false
	}
	f.lastY = e.Offset.Y
}

// grown keeps a following body at its end as the rows arrive.
func (f *processFollow) grown() {
	if f.following {
		f.ref.ScrollToEnd(false)
	}
}

// processGroup is one run of process rows: what pi thought and the calls
// it made between two things it said. latest says whether it is the turn's
// newest group, the one the turn is working in.
func (a *app) processGroup(s *session, t func() turn, node processNode, latest func() bool) core.Node {
	members := node.members
	src := func(m processItem) stepSource {
		return stepSource{s: s, turn: t, id: func() string { return m.step }}
	}
	return core.Func(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		key := s.ID + "/" + node.id
		hasThinking := func() bool { return groupThinking(s, t, node) > 0 }
		rows := func() []toolRun {
			var runs []toolRun
			for _, m := range members {
				runs = append(runs, blockRuns(src(m), m.part)...)
			}
			return runs
		}
		present := func() bool { return hasThinking() || len(rows()) > 0 }
		// The group stays open while the turn works in it and closes once the
		// turn is done, or once a later group took over: only a turn that
		// ended, or one that said something in between, folds its own work.
		auto := func() bool { return latest() && t().running() }
		open := func() bool {
			s.uiSeq.Get() // redraw when the user opens or closes the group
			return s.procOpen(key, auto())
		}
		title := func() string {
			parts := []string{apptext.T("执行过程")}
			if n := len(rows()); n > 0 {
				parts = append(parts, apptext.T("%d 个工具调用", n))
			}
			if n := groupThinking(s, t, node); n > 0 {
				parts = append(parts, apptext.T("%d 次思考", n))
			}
			return strings.Join(parts, " · ")
		}
		// active is what the turn is doing in this group now, shown while the
		// group is its newest and the turn is still working: a thought being
		// written or a call that runs, so the header never says the same thing
		// whatever pi is up to.
		active := func() bool {
			if !auto() {
				return false
			}
			_, _, ok := groupActive(s, t, node)
			return ok
		}
		activeLabel := func() string { return activeTextOf(s, t, node) }
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
					Style:     core.Style{FontSize: 12.5, FontWeight: ui.Medium, MinWidth: core.Pt(0), FlexShrink: 0},
					StyleFunc: ui.Colored(colors.Muted)},
				// What the turn is doing now reads beside the counts, in its own
				// tone: the counts say how much, this says what is happening.
				core.Show{When: active, Then: func(cx *core.Scope) core.Node {
					return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5,
						MinWidth: core.Pt(0), FlexShrink: 1}, Children: []core.Node{
						ui.Spinner{Size: 10},
						core.Text{ContentFunc: activeLabel, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
							Style:     core.Style{FontSize: 12, MinWidth: core.Pt(0), FlexShrink: 1},
							StyleFunc: ui.Colored(colors.Faint)},
					}}
				}},
				ui.IconOf(disclosure(open), 11, colors.Faint),
			},
		}
		body := core.Show{When: open, Then: func(cx *core.Scope) core.Node {
			// A long run reads in a window of its own: the group heads what it
			// holds, and its rows scroll instead of pushing the answer away.
			follow := s.procFollow(key)
			follow.reset()
			return core.Scroll{Ref: &follow.ref, TestID: "process-body", OnScroll: follow.scrolled,
				Style: core.Style{MinWidth: core.Pt(0), Margin: core.Edges{Left: 6},
					Padding: core.Edges{Bottom: 2, Left: 12}, Borders: core.Edges{Left: 1}},
				StyleFunc: func() core.Style {
					return core.Style{MaxHeight: core.Pt(processBodyMax(cx)), BorderColors: core.EdgeColors{Left: colors.Now().Line}}
				},
				Children: []core.Node{
					// The rows sit in a view of their own so a growing body keeps
					// its newest row in sight: while the turn still works in this
					// group, the window follows the end of its rows.
					core.View{OnLayout: func(core.Bounds) {
						if auto() {
							follow.grown()
						}
					}, Style: core.Style{MinWidth: core.Pt(0), FlexShrink: 0, Gap: 4}, Children: []core.Node{
						core.Each(func() []processItem { return members },
							func(m processItem) string { return m.id },
							func(cx *core.Scope, m func() processItem, _ func() int) core.Node {
								return a.memberRows(s, t, m)
							}),
					}},
				}}
		}}
		return core.Show{When: present, Then: func(cx *core.Scope) core.Node {
			return core.View{Style: core.Style{MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{header, body}}
		}}
	})
}

// processSizes is the grid every row of a turn's process draws on: what pi
// thought and each call it made share the time column, the glyph size, the
// gaps and the row's height, so the icons and the figures line up down the
// block instead of stepping in and out.
func (a *app) processSizes() viewkit.ToolSizes {
	return viewkit.ToolSizes{Verb: a.readingRowFont(), Detail: a.readingDetailFont(), Glyph: 14,
		Gap: 8, MinHeight: 28, PadV: 2, PadH: 6}
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
		sizes := a.processSizes()
		children := []core.Node{
			// A thought has no clock of its own, but it keeps the column the
			// calls around it fill, so the rows stay on one vertical line.
			viewkit.TimeCell(cx, sizes.Detail, false, nil),
			ui.Icon(lucide.Brain, sizes.Glyph, func() core.Color { return thinkingTone(cx) }),
			core.Text{ContentFunc: label, MaxLines: 1,
				Style: core.Style{FontSize: sizes.Verb, FontWeight: ui.Medium, FlexShrink: 0}, StyleFunc: ui.Colored(colors.Muted)},
			core.Show{When: open, Then: func(*core.Scope) core.Node { return core.View{Style: core.Style{FlexGrow: 1}} },
				Else: func(*core.Scope) core.Node {
					return core.Text{ContentFunc: preview, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: sizes.Detail,
							LineHeight: a.readingDetailLine()},
						StyleFunc: ui.Colored(colors.Faint)}
				}},
			core.Show{When: src.live, Then: func(*core.Scope) core.Node { return ui.Spinner{Size: 10} }},
			ui.IconOf(disclosure(open), sizes.Glyph-2, colors.Faint),
		}
		body := []core.Node{
			core.View{OnPress: func(core.PressEvent) { s.toggleOpen(key) }, Role: core.RoleButton, LabelFunc: label,
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: sizes.Gap,
						MinHeight: core.Pt(sizes.MinHeight), Padding: core.Symmetric(sizes.PadV, sizes.PadH),
						CornerRadius: 5, Hover: &core.Style{Background: colors.Hover()}}
				},
				Children: children},
			core.Show{When: open, Then: func(cx *core.Scope) core.Node {
				// Long reasoning opens to a window of its own: the group is the
				// summary, and one thought must not push the answer away. It
				// starts in the row's own column, under the glyph that heads it.
				return core.Scroll{Style: core.Style{MinWidth: core.Pt(0), MaxHeight: core.Pt(320)},
					Children: []core.Node{core.View{Style: core.Style{MinWidth: core.Pt(0),
						Padding: core.Edges{Left: viewkit.ContentLeft(sizes), Top: 2, Bottom: 4}},
						Children: []core.Node{viewkit.MarkdownLive(a.chatSearch, func() string { return src.thinking() }, src.live,
							sizes.Verb, a.readingRowLine(), core.Style{Color: colors.Muted(), FontWeight: core.FontWeight(350)}, a.codeWrap.Get)}}}}
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
