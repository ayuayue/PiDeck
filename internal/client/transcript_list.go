package client

import (
	"slices"
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// A message's ordinal is relative to its turn, so prepending older pages
// cannot change the key of the match already on screen.
type transcriptRowKey struct{ Turn, Ordinal int }

// The kinds of row the phone draws.
const (
	// rowLine is one line of the conversation.
	rowLine = iota
	// rowProcess is a finished turn's thinking and tool calls, folded into
	// the one summary row the desktop closes a turn with.
	rowProcess
	// rowWorking is the spinner under a turn that is still going.
	rowWorking
)

type transcriptRow struct {
	key      transcriptRowKey
	kind     int
	messages []remotewire.Message
	live     bool
	turn     int
}

// isProcessLine says a message is part of a turn's process rather than its
// conversation.
func isProcessLine(m remotewire.Message) bool {
	return m.Role == "thinking" || m.Role == "tool"
}

// transcriptRows groups the loaded messages into rows. The running turn
// keeps its process open, so a call appears as pi makes it; every finished
// turn folds its process into one row, as the desktop does.
func transcriptRows(messages []remotewire.Message, searching bool, liveTurn int) []transcriptRow {
	rows := make([]transcriptRow, 0, len(messages))
	ordinals := make(map[int]int)
	next := func(turn int) transcriptRowKey {
		ordinals[turn]++
		return transcriptRowKey{turn, ordinals[turn]}
	}
	for i := 0; i < len(messages); {
		turn := messages[i].Turn
		j := i
		for j < len(messages) && messages[j].Turn == turn {
			j++
		}
		part := messages[i:j]
		i = j
		if searching || turn == liveTurn {
			// Searching shows every line it might match, and the running
			// turn shows its process as it happens.
			for _, m := range part {
				rows = append(rows, transcriptRow{key: next(turn), kind: rowLine,
					messages: []remotewire.Message{m}, turn: turn, live: turn == liveTurn})
			}
			continue
		}
		var process []remotewire.Message
		for _, m := range part {
			if isProcessLine(m) {
				process = append(process, m)
			}
		}
		emitted := false
		for _, m := range part {
			if isProcessLine(m) {
				if !emitted {
					rows = append(rows, transcriptRow{key: next(turn), kind: rowProcess, messages: process, turn: turn})
					emitted = true
				}
				continue
			}
			rows = append(rows, transcriptRow{key: next(turn), kind: rowLine, messages: []remotewire.Message{m}, turn: turn})
		}
	}
	if liveTurn >= 0 && !searching {
		rows = append(rows, transcriptRow{key: transcriptRowKey{liveTurn, -1}, kind: rowWorking, turn: liveTurn, live: true})
	}
	return rows
}

func transcriptMatches(rows []transcriptRow, query string) []int {
	if query == "" {
		return nil
	}
	var matched []int
	for i, row := range rows {
		for _, m := range row.messages {
			if m.Role != "image" && strings.Contains(strings.ToLower(m.Text), query) {
				matched = append(matched, i)
				break
			}
		}
	}
	return matched
}

func (a *mobileApp) transcriptList() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		query := core.NewMemo(cx, func() string { return strings.ToLower(strings.TrimSpace(a.findText.Get())) })
		liveTurn := core.NewMemo(cx, func() int {
			messages := a.messages.Get()
			if !a.running.Get() || len(messages) == 0 {
				return -1
			}
			// The last turn is the one pi is working on: the desktop sends
			// its live words under that turn's number.
			return messages[len(messages)-1].Turn
		})
		rows := core.NewMemoFunc(cx, func() []transcriptRow {
			return transcriptRows(a.messages.Get(), query.Get() != "", liveTurn.Get())
		}, nil)
		matches := core.NewMemoFunc(cx, func() []int { return transcriptMatches(rows.Get(), query.Get()) }, slices.Equal)
		selected := func() int {
			key, list := a.findSelected.Get(), rows.Get()
			return slices.IndexFunc(matches.Get(), func(i int) bool { return list[i].key == key })
		}
		move := func(delta int) {
			hits, list := matches.GetUntracked(), rows.GetUntracked()
			if len(hits) == 0 {
				return
			}
			at := slices.IndexFunc(hits, func(i int) bool { return list[i].key == a.findSelected.GetUntracked() })
			if at < 0 {
				at = 0
				if delta < 0 {
					at = len(hits) - 1
				}
			} else {
				at = (at + delta + len(hits)) % len(hits)
			}
			i := hits[at]
			a.findSelected.Set(list[i].key)
			a.scroll.ScrollToIndexAt(i, 0.12, 0, false)
		}
		cx.Effect(func() {
			if len(matches.Get()) > 0 && selected() < 0 {
				cx.Post(func() {
					if a.findOpen.GetUntracked() {
						move(0)
					}
				})
			}
		})
		colors := ui.ColorsOf(cx)
		return core.View{Style: ui.FillRest, Children: []core.Node{
			core.Show{When: a.findOpen.Get, Then: func(cx *core.Scope) core.Node { return a.findBar(cx, matches.Get, selected, move) }},
			core.List{Ref: a.scroll, TestID: "mobile-transcript-list", Alignment: core.ListAlignEnd,
				Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), Padding: core.Edges{Top: 14, Bottom: 20, Left: 14, Right: 14}},
				Gap:   12, EstimatedSize: 56, ScrollEventThrottle: 120 * time.Millisecond,
				OnScroll: func(e core.ScrollEvent) {
					a.atBottom.Set(e.Offset.Y+e.Size.Height >= e.ContentSize.Height-90)
				}, Count: func() int { return len(rows.Get()) }, Key: func(i int) any { return rows.Get()[i].key },
				Header: core.Group{
					core.Show{When: func() bool { return a.messagesBefore.Get() > 0 }, Then: func(*core.Scope) core.Node { return a.olderMessagesRow(colors) }},
					core.Show{When: a.transcriptTruncated.Get, Then: func(*core.Scope) core.Node { return truncatedTranscriptRow(colors) }},
				}, Empty: core.Dynamic(func(cx *core.Scope) core.Node {
					if a.transcriptBusy.Get() {
						return ui.Skeleton{Lines: 4, Avatar: true, Label: apptext.T("正在读取会话")}
					}
					return core.View{Style: core.Style{Padding: core.All(32), AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
						ui.Icon(lucide.MessageSquare, 26, colors.Faint),
						ui.Text(apptext.T("这个会话还没有消息"), 12.5, ui.Regular, colors.Muted),
					}}
				}), Row: func(cx *core.Scope, row core.ListRow) core.Node {
					return core.Dynamic(func(cx *core.Scope) core.Node {
						i, list := row.Index(), rows.Get()
						if i < 0 || i >= len(list) {
							return nil
						}
						r := list[i]
						if r.kind == rowWorking {
							return workingRow(colors)
						}
						if r.kind == rowProcess {
							return a.processRow(cx, r)
						}
						match := r.key == a.findSelected.Get()
						body := a.message(cx, r.messages[0], r.live, match, r.key)
						if match {
							return core.View{TestID: "mobile-find-selected", Style: core.Style{Padding: core.All(4), CornerRadius: ui.RadiusControl},
								StyleFunc: func() core.Style { return core.Style{Background: ui.Alpha(colors.Accent(), 0.10)} }, Children: []core.Node{body}}
						}
						return body
					})
				}},
		}}
	})
}

func truncatedTranscriptRow(colors ui.Colors) core.Node {
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6,
		Padding: core.Symmetric(6, 10), CornerRadius: ui.RadiusControl, Background: colors.Inset()}, Children: []core.Node{
		ui.Icon(lucide.Scissors, 12, colors.Faint),
		core.Text{Content: apptext.T("有一条消息太长，只带了前面一部分。"), MaxLines: 2,
			Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11}, StyleFunc: ui.Colored(colors.Faint)},
	}}
}
