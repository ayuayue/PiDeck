package client

// The phone build: it connects to a desktop PiDeck Lite server and browses
// its projects, sessions and transcripts. The same package builds the
// desktop; Root picks this screen on iOS and Android (or with
// PIDECK_LITE_MOBILE=1 for a preview on a desktop).

import (
	"fmt"
	"strings"
	"time"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/remotewire"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// toolBlock folds a run of tool calls into one row that opens in place.
func (a *mobileApp) toolBlock(cx *core.Scope, lines []remotewire.Message, key string) core.Node {
	colors := ui.ColorsOf(cx)
	open := a.toolOpen.Get() == key
	header := "调用了 " + fmt.Sprint(len(lines)) + " 个工具"
	if len(lines) == 1 {
		header = viewkit.FirstLine(lines[0].Text, 40)
	}
	children := []core.Node{
		core.View{OnPress: func(core.PressEvent) {
			if open {
				a.toolOpen.Set("")
			} else {
				a.toolOpen.Set(key)
			}
		}, Role: core.RoleButton, Label: header, TestID: "mobile-tools",
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Symmetric(4, 6),
					CornerRadius: 7, Transition: viewkit.PressMotion, Hover: &core.Style{Background: colors.Hover()},
					Active: &core.Style{Background: colors.Pressed()}}
			},
			Children: []core.Node{
				ui.Icon(lucide.Terminal, 12, colors.Faint),
				core.Text{Content: header, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: viewkit.MonoFont(), FontSize: 10.5},
					StyleFunc: ui.Colored(colors.Faint)},
				ui.Icon(map[bool]func() *core.SVG{true: lucide.ChevronUp, false: lucide.ChevronDown}[open], 12, colors.Faint),
			}},
	}
	if open {
		inner := make([]core.Node, 0, len(lines))
		for _, line := range lines {
			inner = append(inner, core.Text{Content: line.Text, MaxLines: 12,
				Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10.5, LineHeight: 16}, StyleFunc: ui.Colored(colors.Muted)})
		}
		children = append(children, core.View{Style: core.Style{Gap: 4, Padding: core.Edges{Left: 18, Top: 2, Bottom: 4}},
			Children: inner})
	}
	return core.View{Style: core.Style{Gap: 2}, Children: children}
}

// message draws one line of a remote transcript; holding it copies its
// text.
func (a *mobileApp) message(cx *core.Scope, m remotewire.Message, live, selected bool) core.Node {
	if m.Role == "image" {
		return a.transcriptImageRow(m)
	}
	body := a.messageBody(cx, m, live, selected)
	if strings.TrimSpace(m.Text) == "" {
		return body
	}
	return core.View{OnLongPress: func(core.PressEvent) {
		a.cx.SetClipboard(m.Text)
		a.flash("已复制")
	}, Children: []core.Node{body}}
}

// noticePill is the short confirmation every screen shows.
func (a *mobileApp) noticePill() core.Node {
	return core.Show{When: func() bool { return a.notice.Get() != "" }, Then: func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return core.View{Style: core.Style{Position: core.Absolute, Left: core.Pt(0), Right: core.Pt(0), Bottom: core.Pt(120),
			AlignItems: core.AlignCenter, PointerEvents: core.PointerEventsBoxNone}, Children: []core.Node{
			core.View{StyleFunc: func() core.Style {
				return core.Style{Padding: core.Symmetric(7, 15), CornerRadius: 16, Background: colors.Light()}
			}, Children: []core.Node{ui.Text(a.notice.Get(), 12, ui.Medium, colors.OnLight)}},
		}}
	}}
}

// flash shows a short confirmation over the composer.
func (a *mobileApp) flash(text string) {
	a.notice.Set(text)
	a.cx.AfterFunc(1600*time.Millisecond, func() {
		if a.notice.GetUntracked() == text {
			a.notice.Set("")
		}
	})
}

// thinkingReveal is how much of a long block shows before the rest is
// asked for: about a phone screen of reasoning.
const thinkingReveal = 600

// thoughtKey names a thinking block for its folded state: the opening of
// its text, which stays put as the rest grows.
func thoughtKey(text string) string {
	r := []rune(strings.TrimSpace(text))
	if len(r) > 24 {
		r = r[:24]
	}
	return string(r)
}

// thoughtOpened says a thinking block is unfolded.
func (a *mobileApp) thoughtOpened(key string) bool {
	return hasKey(a.thoughtOpen.Get(), key)
}

// toggleThought folds or unfolds one thinking block.
func (a *mobileApp) toggleThought(key string) {
	a.thoughtOpen.Set(toggleKey(a.thoughtOpen.GetUntracked(), key))
}

// thoughtShowsAll says the rest of a long block was asked for.
func (a *mobileApp) thoughtShowsAll(key string) bool {
	return hasKey(a.thoughtFull.GetUntracked(), key)
}

// expandThought shows the rest of one long block.
func (a *mobileApp) expandThought(key string) {
	if !a.thoughtShowsAll(key) {
		a.thoughtFull.Set(toggleKey(a.thoughtFull.GetUntracked(), key))
	}
}

// toggleKey adds key to list, or drops it when it is there.
func toggleKey(list []string, key string) []string {
	out := make([]string, 0, len(list)+1)
	found := false
	for _, k := range list {
		if k == key {
			found = true
			continue
		}
		out = append(out, k)
	}
	if !found {
		out = append(out, key)
	}
	return out
}

// hasKey says list holds key.
func hasKey(list []string, key string) bool {
	for _, k := range list {
		if k == key {
			return true
		}
	}
	return false
}

// messageBody draws one line, without the copy gesture.
func (a *mobileApp) messageBody(cx *core.Scope, m remotewire.Message, live, selected bool) core.Node {
	colors := ui.ColorsOf(cx)
	switch m.Role {
	case "user":
		// A pasted attachment or a long system block would fill the screen:
		// show its head, and open it in place when asked.
		text := m.Text
		runes := []rune(text)
		if len(runes) > 400 && !selected {
			key := string(runes[:64])
			if a.longOpen.Get() != key {
				text = string(runes[:400]) + "…"
			}
			return core.View{OnPress: func(core.PressEvent) {
				if a.longOpen.Get() == key {
					a.longOpen.Set("")
				} else {
					a.longOpen.Set(key)
				}
			}, Role: core.RoleButton, Label: apptext.T("长消息"), TestID: "mobile-long",
				Style: core.Style{Direction: core.Row, JustifyContent: core.JustifyEnd}, Children: []core.Node{
					core.View{Style: core.Style{MaxWidth: core.Pct(86), Padding: core.Symmetric(9, 13), CornerRadius: 15,
						Background: colors.Light()}, Children: []core.Node{
						core.Text{Content: text, Style: core.Style{FontSize: 14, LineHeight: 20}, StyleFunc: ui.Colored(colors.OnLight)},
						core.Text{Content: func() string {
							if a.longOpen.Get() == key {
								return apptext.T("收起")
							}
							return apptext.T("展开全文（%d 字）", len(runes))
						}(), Style: core.Style{FontSize: 10.5, Padding: core.Edges{Top: 6}},
							StyleFunc: ui.Colored(func() core.Color { return ui.Alpha(colors.OnLight(), 0.6) })},
					}},
				}}
		}
		return core.View{Style: core.Style{Direction: core.Row, JustifyContent: core.JustifyEnd}, Children: []core.Node{
			core.View{Style: core.Style{MaxWidth: core.Pct(86), Padding: core.Symmetric(9, 13), CornerRadius: 15,
				Background: colors.Light()}, Children: []core.Node{
				core.Text{Content: m.Text, Style: core.Style{FontSize: 14, LineHeight: 20}, StyleFunc: ui.Colored(colors.OnLight)},
			}},
		}}
	case "thinking":
		// Three levels: a line, its head, all of it. Long reasoning then
		// costs one press rather than a screen.
		key := thoughtKey(m.Text)
		open := func() bool { return live || selected || a.thoughtOpened(key) }
		all := func() bool { return live || selected || a.thoughtShowsAll(key) }
		head, more := viewkit.Reveal(m.Text, thinkingReveal)
		left := viewkit.LeftOver(m.Text, head)
		header := []core.Node{
			ui.Icon(lucide.Brain, 13, colors.Faint),
			ui.Text(apptext.T("思考"), 11, ui.Medium, colors.Muted),
		}
		if !open() {
			header = append(header, core.Text{Content: viewkit.FirstLine(m.Text, 80), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11}, StyleFunc: ui.Colored(colors.Faint)})
		} else {
			header = append(header, core.View{Style: core.Style{FlexGrow: 1}})
		}
		header = append(header, ui.IconOf(func() *core.SVG {
			if open() {
				return lucide.ChevronUp()
			}
			return lucide.ChevronDown()
		}, 12, colors.Faint))
		body := []core.Node{core.View{OnPress: func(core.PressEvent) { a.toggleThought(key) }, Role: core.RoleButton,
			Label: apptext.T("思考"), TestID: "mobile-thought",
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, MinHeight: core.Pt(26),
					CornerRadius: 6, Transition: viewkit.PressMotion, Active: &core.Style{Background: colors.Pressed()}}
			}, Children: header}}
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
							Padding: core.Symmetric(0, 2), CornerRadius: 5, Transition: viewkit.PressMotion,
							Active: &core.Style{Background: colors.Pressed()}}
					}, Children: []core.Node{
						ui.Text(apptext.T("展开其余（还有 %d 字）", left), 10.5, ui.Medium, colors.Muted),
						ui.Icon(lucide.ChevronDown, 11, colors.Faint),
					}})
			}
			return core.View{Style: core.Style{Gap: 2}, Children: rows}
		}})
		return core.View{Style: core.Style{Gap: 3, Padding: core.Symmetric(7, 10), CornerRadius: 10,
			Background: colors.Inset()}, Children: body}
	case "tool":
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Padding: core.Symmetric(2, 4)}, Children: []core.Node{
			ui.Icon(lucide.Terminal, 12, colors.Faint),
			core.Text{Content: m.Text, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: viewkit.MonoFont(), FontSize: 10.5, LineHeight: 16},
				StyleFunc: ui.Colored(colors.Faint)},
		}}
	case "note":
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, AlignSelf: core.AlignCenter}, Children: []core.Node{
			ui.Icon(lucide.Info, 11, colors.Faint),
			core.Text{Content: m.Text, Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)},
		}}
	case "error":
		return core.View{Style: core.Style{Padding: core.Symmetric(9, 11), CornerRadius: 10, Background: ui.Alpha(colors.Danger(), 0.08)}, Children: []core.Node{
			core.Text{Content: m.Text, Style: core.Style{FontSize: 12, LineHeight: 18}, StyleFunc: ui.Colored(colors.Danger)},
		}}
	}
	return viewkit.Markdown(m.Text, func() bool { return false }, false)
}
