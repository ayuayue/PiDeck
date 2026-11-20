package client

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// A message's ordinal is relative to its turn, so prepending older pages
// cannot change the key of the match already on screen.
type transcriptRowKey struct{ Turn, Ordinal int }

type transcriptRow struct {
	key      transcriptRowKey
	messages []remotewire.Message
	toolFold bool
	live     bool
}

func transcriptRows(messages []remotewire.Message, searching bool) []transcriptRow {
	rows := make([]transcriptRow, 0, len(messages))
	ordinals := make(map[int]int)
	for i := 0; i < len(messages); {
		m := messages[i]
		j := i + 1
		fold := !searching && m.Role == "tool"
		if fold {
			for j < len(messages) && messages[j].Turn == m.Turn && messages[j].Role == "tool" {
				j++
			}
		}
		rows = append(rows, transcriptRow{key: transcriptRowKey{m.Turn, ordinals[m.Turn] + 1},
			messages: messages[i:j], toolFold: fold, live: i >= len(messages)-2})
		ordinals[m.Turn] += j - i
		i = j
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
		rows := core.NewMemoFunc(cx, func() []transcriptRow {
			return transcriptRows(a.messages.Get(), query.Get() != "")
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
						if r.toolFold {
							return a.toolBlock(cx, r.messages, fmt.Sprintf("%d/%d", r.key.Turn, r.key.Ordinal))
						}
						match := r.key == a.findSelected.Get()
						body := a.message(cx, r.messages[0], r.live && a.running.Get(), match)
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
