package client

// The phone build: it connects to a desktop PiDeck server and browses
// its projects, sessions and transcripts. The same package builds the
// desktop; Root picks this screen on iOS and Android (or with
// PIDECK_V2_MOBILE=1 for a preview on a desktop).

import (
	"strings"
	"time"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/remotewire"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// message draws one line of a remote transcript; holding it copies its
// text.
func (a *mobileApp) message(cx *core.Scope, m remotewire.Message, live, selected bool, key transcriptRowKey) core.Node {
	if m.Role == "image" {
		return a.transcriptImageRow(m)
	}
	body := a.messageBody(cx, m, live, selected, key)
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
func (a *mobileApp) messageBody(cx *core.Scope, m remotewire.Message, live, selected bool, key transcriptRowKey) core.Node {
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
		return a.thinkingRow(cx, m, live, selected)
	case "tool":
		return a.toolLineRow(cx, m, key)
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
