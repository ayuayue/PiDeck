package client

// The phone build: it connects to a desktop PiDeck V2 server and browses
// its projects, sessions and transcripts. The same package builds the
// desktop; Root picks this screen on iOS and Android (or with
// PIDECK_V2_MOBILE=1 for a preview on a desktop).

import (
	"fmt"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// processRow is one finished turn's process folded into a row of its own,
// the way the desktop closes a completed turn: the summary above the
// answer, opening on the thinking and the calls behind it.
func (a *mobileApp) processRow(cx *core.Scope, row transcriptRow) core.Node {
	colors := ui.ColorsOf(cx)
	key := fmt.Sprintf("turn/%d", row.turn)
	open := a.processOpened(key)
	tools := 0
	for _, m := range row.messages {
		if m.Role == "tool" {
			tools++
		}
	}
	label := apptext.T("过程")
	if tools > 0 {
		label = apptext.T("%d 个工具调用", tools)
	}
	divider := func() core.Node {
		return core.View{Style: core.Style{FlexGrow: 1, Height: core.Pt(1)}, StyleFunc: ui.Filled(colors.Line)}
	}
	disclosure := core.View{
		OnPress: func(core.PressEvent) { a.toggleProcess(key) },
		Role:    core.RoleButton, Label: label, TestID: "mobile-process",
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Height: core.Pt(26),
				Padding: core.Symmetric(0, 6), CornerRadius: 7, Transition: viewkit.PressMotion,
				Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{
			ui.Text(label, 11.5, ui.Medium, colors.Muted),
			ui.IconOf(func() *core.SVG {
				if open {
					return lucide.ChevronUp()
				}
				return lucide.ChevronRight()
			}, 11, colors.Faint),
		}}
	children := []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(26)},
			Children: []core.Node{divider(), disclosure, divider()}},
	}
	if open {
		inner := make([]core.Node, 0, len(row.messages))
		for i, m := range row.messages {
			inner = append(inner, a.messageBody(cx, m, false, false, transcriptRowKey{row.turn, i + 1}))
		}
		children = append(children, core.View{Style: core.Style{Gap: 6, Padding: core.Edges{Top: 6, Bottom: 2}}, Children: inner})
	}
	return core.View{TestID: "mobile-process-block", Style: core.Style{Gap: 2}, Children: children}
}

// processOpened says the user unfolded that turn's process.
func (a *mobileApp) processOpened(key string) bool {
	return hasKey(a.procOpen.Get(), key)
}

// toggleProcess folds or unfolds one turn's process.
func (a *mobileApp) toggleProcess(key string) {
	a.procOpen.Set(toggleKey(a.procOpen.GetUntracked(), key))
}

// toolLineRow is one tool call, the desktop's row in the phone's size: its
// glyph, the verb, the target, what it changed, how long it took, and its
// output when opened.
func (a *mobileApp) toolLineRow(cx *core.Scope, m remotewire.Message, key transcriptRowKey) core.Node {
	colors := ui.ColorsOf(cx)
	tool := m.Tool
	if tool == nil {
		tool = &remotewire.ToolLine{}
	}
	openKey := fmt.Sprintf("tool/%d/%d", key.Turn, key.Ordinal)
	hasBody := strings.TrimSpace(tool.Output) != ""
	open := a.toolOpen.Get() == openKey
	running := tool.Status == "running"
	failed := tool.Status == "error"
	detailSize := core.Points(10.5)
	header := viewkit.ToolRow(cx, viewkit.ToolLine{
		Glyph:      toolGlyph(tool.Name),
		Verb:       toolVerb(tool, m.Text),
		Detail:     tool.Detail,
		Added:      tool.Added,
		Removed:    tool.Removed,
		Nested:     tool.Nested,
		DurationMs: tool.DurationMs,
		Running:    running,
		Failed:     failed,
		Open:       open,
		HasBody:    hasBody,
	}, viewkit.ToolSizes{Verb: 12, Detail: detailSize, Glyph: 13, Gap: 6, MinHeight: 26, PadV: 1, PadH: 2})
	children := []core.Node{header}
	if open && hasBody {
		// What a change touched is a patch, and shows as one.
		body := []core.Node{core.Scroll{Style: core.Style{MaxHeight: core.Pt(240)}, Children: []core.Node{
			core.Text{Content: tool.Output, Selectable: core.SelectableOn,
				Style:     core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10, LineHeight: 15},
				StyleFunc: ui.Colored(colors.Muted)}}}}
		if tool.Diff {
			body = []core.Node{patchBody(func() string { return tool.Output }, "mobile-tool-diff", 240)}
		}
		children = append(children, core.View{Style: core.Style{Padding: core.Edges{Left: 19, Top: 2, Bottom: 4}}, Children: body})
	}
	return core.View{
		OnPress: func(core.PressEvent) {
			if !hasBody {
				return
			}
			if open {
				a.toolOpen.Set("")
			} else {
				a.toolOpen.Set(openKey)
			}
		},
		Role: core.RoleButton, LabelFunc: func() string { return strings.TrimSpace(tool.Action + " " + tool.Detail) },
		TestID: "mobile-tool-row",
		StyleFunc: func() core.Style {
			st := core.Style{MinWidth: core.Pt(0), CornerRadius: 7, Overflow: core.Hidden}
			if hasBody {
				st.Active = &core.Style{Background: colors.Pressed()}
			}
			if open {
				st.Background = colors.Inset()
			}
			return st
		},
		Children: children,
	}
}

// toolVerb is what the row calls the call: the tool's own verb, or the
// line the desktop sent when it had none.
func toolVerb(tool *remotewire.ToolLine, fallback string) string {
	if tool.Action != "" {
		return tool.Action
	}
	return viewkit.FirstLine(fallback, 24)
}

// toolGlyph is the icon of what a tool does, by the name pi gave it.
func toolGlyph(name string) func() *core.SVG {
	switch name {
	case "bash", "shell", "exec":
		return lucide.Terminal
	case "read", "view":
		return lucide.FileText
	case "write":
		return lucide.FilePlus
	case "edit", "str_replace", "apply_patch":
		return lucide.Pencil
	case "grep", "find", "search", "web_search", "websearch":
		return lucide.Search
	case "ls", "glob":
		return lucide.Folder
	case "fetch", "fetch_content", "webfetch", "web_fetch":
		return lucide.Globe
	case "todo", "todowrite":
		return lucide.ListChecks
	case "task", "agent", "Agent", "delegate", "acp_delegate", "subagent":
		return lucide.Bot
	case "codemode":
		return lucide.Code
	}
	return lucide.Wrench
}

// thinkingRow is one reasoning block: the desktop's fold, with a single
// line that keeps moving while pi is still thinking.
func (a *mobileApp) thinkingRow(cx *core.Scope, m remotewire.Message, live, selected bool) core.Node {
	colors := ui.ColorsOf(cx)
	key := thoughtKey(m.Text)
	open := func() bool { return live || selected || a.thoughtOpened(key) }
	all := func() bool { return live || selected || a.thoughtShowsAll(key) }
	head, more := viewkit.Reveal(m.Text, thinkingReveal)
	left := viewkit.LeftOver(m.Text, head)
	header := []core.Node{
		ui.Icon(lucide.Brain, 12, colors.Faint),
		ui.Text(apptext.T("思考"), 11, ui.Medium, colors.Muted),
	}
	if live {
		// One line under way: the newest words stay in sight and the earlier
		// ones run off the start, as a marquee does.
		header = append(header, core.Text{Content: tailLine(m.Text, liveThinkingRunes), MaxLines: 1,
			EllipsizeMode: core.EllipsizeHead,
			Style:         core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11},
			StyleFunc:     ui.Colored(colors.Faint)})
	} else if !open() {
		header = append(header, core.Text{Content: viewkit.FirstLine(m.Text, 80), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
			Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11}, StyleFunc: ui.Colored(colors.Faint)})
	} else {
		header = append(header, core.View{Style: core.Style{FlexGrow: 1}})
	}
	if !live {
		header = append(header, ui.IconOf(func() *core.SVG {
			if open() {
				return lucide.ChevronUp()
			}
			return lucide.ChevronDown()
		}, 11, colors.Faint))
	}
	row := core.View{
		OnPress: func(core.PressEvent) {
			if !live {
				a.toggleThought(key)
			}
		},
		Role: core.RoleButton, Label: apptext.T("思考"), TestID: "mobile-thought",
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinHeight: core.Pt(26),
				CornerRadius: 6, Transition: viewkit.PressMotion, Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: header,
	}
	body := []core.Node{row}
	if !live {
		body = append(body, core.Show{When: open, Then: func(*core.Scope) core.Node {
			var rows []core.Node
			text := m.Text
			if !all() {
				text = head
			}
			rows = append(rows, core.Text{Content: text, Style: core.Style{FontSize: 12, LineHeight: 18},
				StyleFunc: ui.Colored(colors.Muted)})
			if more && !all() {
				rows = append(rows, core.View{OnPress: func(core.PressEvent) { a.expandThought(key) }, Role: core.RoleButton,
					Label: apptext.T("展开其余"), TestID: "mobile-thought-more",
					StyleFunc: func() core.Style {
						return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, MinHeight: core.Pt(24),
							CornerRadius: 5, Active: &core.Style{Background: colors.Pressed()}}
					}, Children: []core.Node{
						ui.Text(apptext.T("展开其余（还有 %d 字）", left), 10.5, ui.Medium, colors.Muted),
						ui.Icon(lucide.ChevronDown, 11, colors.Faint),
					}})
			}
			return core.View{Style: core.Style{Gap: 2}, Children: rows}
		}})
	}
	return core.View{Style: core.Style{Gap: 3, Padding: core.Symmetric(6, 9), CornerRadius: 9,
		Background: colors.Inset()}, Children: body}
}

// liveThinkingRunes is how much of a running thought the one line keeps:
// enough that the tail fills a phone's width at the reading size.
const liveThinkingRunes = 400

// tailLine is the end of a long text, so a single line shows the newest
// words rather than a head that never moves.
func tailLine(text string, limit int) string {
	runes := []rune(strings.TrimSpace(text))
	if len(runes) <= limit {
		return string(runes)
	}
	return "…" + string(runes[len(runes)-limit:])
}

// workingRow is the line under a running turn: pi is at work, but has not
// said anything yet.
func workingRow(colors ui.Colors) core.Node {
	return core.View{TestID: "mobile-working", Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7,
		Padding: core.Symmetric(2, 4)}, Children: []core.Node{
		ui.Spinner{Size: 11, Label: apptext.T("正在工作")},
		ui.Text(apptext.T("正在工作"), 12, ui.Medium, colors.Muted),
	}}
}
