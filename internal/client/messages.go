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
func (a *mobileApp) toolBlock(cx *core.Scope, lines []remotewire.Message) core.Node {
	colors := ui.ColorsOf(cx)
	key := lines[0].Text
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
func (a *mobileApp) message(cx *core.Scope, m remotewire.Message) core.Node {
	body := a.messageBody(cx, m)
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

// messageBody draws one line, without the copy gesture.
func (a *mobileApp) messageBody(cx *core.Scope, m remotewire.Message) core.Node {
	colors := ui.ColorsOf(cx)
	switch m.Role {
	case "user":
		// A pasted attachment or a long system block would fill the screen:
		// show its head, and open it in place when asked.
		text := m.Text
		runes := []rune(text)
		if len(runes) > 400 {
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
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignStart, Gap: 7, Padding: core.Symmetric(7, 10), CornerRadius: 10,
			Background: colors.Inset()}, Children: []core.Node{
			ui.Icon(lucide.Brain, 13, colors.Faint),
			core.Text{Content: m.Text, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12, LineHeight: 18},
				StyleFunc: ui.Colored(colors.Muted)},
		}}
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
