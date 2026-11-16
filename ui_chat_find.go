//go:build !js && !android && !ios

package main

// Finding a turn in the open conversation: a floating field over the
// transcript that keeps only the turns whose text matches.

import (
	"strings"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// findQuery is the text the transcript is filtered by, empty when the
// find bar is closed.
func (a *app) findQuery() string {
	if !a.chatFindOpen.Get() {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(a.chatFindText.Get()))
}

// openChatFind shows the find bar, or closes it when it is open.
func (a *app) openChatFind() {
	if a.active() == nil {
		return
	}
	if a.chatFindOpen.GetUntracked() {
		a.closeChatFind()
		return
	}
	a.chatFindOpen.Set(true)
	a.chatSearch.SetRevealMargin(core.Edges{Top: 48, Bottom: 12})
	a.chatSearch.Open()
}

// closeChatFind hides the find bar and stops highlighting.
func (a *app) closeChatFind() {
	a.chatFindOpen.Set(false)
	a.chatFindText.Set("")
	a.chatSearch.SetQuery("")
	a.chatSearch.Close()
}

// setChatFind filters the transcript and highlights the matches in it.
func (a *app) setChatFind(q string) {
	a.chatFindText.Set(q)
	a.chatSearch.SetQuery(strings.TrimSpace(q))
}

// turnMatches reports whether a turn's text holds the query.
func turnMatches(t turn, q string) bool {
	if q == "" {
		return true
	}
	holds := func(s string) bool { return strings.Contains(strings.ToLower(s), q) }
	if holds(t.Prompt) || holds(t.Final) || holds(t.Err) {
		return true
	}
	for _, st := range t.Steps {
		if holds(st.Text) || holds(st.Thinking) {
			return true
		}
		for _, tr := range st.Tools {
			if holds(tr.Detail) || holds(tr.Output) {
				return true
			}
		}
	}
	return false
}

// chatFindBar floats over the transcript with the query and its count.
func (a *app) chatFindBar(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		q := strings.ToLower(strings.TrimSpace(a.chatFindText.Get()))
		matched := 0
		if q != "" {
			for _, t := range s.turns.Get() {
				if turnMatches(t, q) {
					matched++
				}
			}
		}
		count := T("%d 条匹配", matched)
		if q == "" {
			count = T("输入关键词筛选对话")
		}
		hits := a.chatSearch.Count()
		return core.View{TestID: "chat-find", Style: core.Style{Position: core.Absolute, Top: core.Pt(10), Right: core.Pt(24),
			Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Symmetric(4, 8), CornerRadius: 9,
			Background: colors.Surface(), BorderWidth: 1, BorderColor: colors.Border()},
			Children: []core.Node{
				ui.Icon(lucide.Search, 12, colors.Faint),
				core.Input{Value: a.chatFindText.Get, OnChange: a.setChatFind, OnSubmit: func(string) { a.chatSearch.Next() },
					Placeholder: T("在会话里查找…"), Label: T("在会话里查找"), TestID: "chat-find-input", AutoFocus: true,
					Style: core.Style{Width: core.Pt(170), Height: core.Pt(26), Padding: core.Symmetric(0, 6), CornerRadius: 6,
						FontSize: 11.5, Color: colors.Text(), Background: colors.Field()}},
				core.Text{Content: count, MaxLines: 1, TestID: "chat-find-count",
					Style: core.Style{MinWidth: core.Pt(56), FontSize: 10}, StyleFunc: ui.Colored(colors.Muted)},
				core.Show{When: func() bool { return q != "" && hits > 0 }, Then: func(cx *core.Scope) core.Node {
					return core.Group{
						ui.Text(T("%d 处", hits), 10, ui.Regular, colors.Faint),
						hintOf(func() string { return T("上一处") }, ui.IconButton{Icon: lucide.ChevronUp, Label: T("上一处"), Size: 20, IconSize: 10, TestID: "chat-find-prev",
							OnPress: a.chatSearch.Previous}),
						hintOf(func() string { return T("下一处") }, ui.IconButton{Icon: lucide.ChevronDown, Label: T("下一处"), Size: 20, IconSize: 10, TestID: "chat-find-next",
							OnPress: a.chatSearch.Next}),
					}
				}},
				hintOf(func() string { return T("关闭查找") }, ui.IconButton{Icon: lucide.X, Label: T("关闭查找"), Size: 22, IconSize: 11, TestID: "chat-find-close",
					OnPress: a.closeChatFind}),
			}}
	})
}
