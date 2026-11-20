package client

// The phone build: it connects to a desktop PiDeck Lite server and browses
// its projects, sessions and transcripts. The same package builds the
// desktop; Root picks this screen on iOS and Android (or with
// PIDECK_LITE_MOBILE=1 for a preview on a desktop).

import (
	"fmt"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/remotewire"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// olderMessagesRow asks for the turns before the loaded page: a long
// session arrives a page at a time, so its start is never lost.
func (a *mobileApp) olderMessagesRow(colors ui.Colors) core.Node {
	return core.View{OnPress: func(core.PressEvent) { a.loadOlderTranscript() }, Role: core.RoleButton,
		Label: apptext.T("加载更早的消息"), TestID: "mobile-older",
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 6,
				MinHeight: core.Pt(34), Padding: core.Symmetric(6, 10), CornerRadius: 9, Background: colors.Inset(),
				Transition: viewkit.PressMotion, Active: &core.Style{Background: colors.Pressed()}}
		}, Children: []core.Node{
			core.Dynamic(func(cx *core.Scope) core.Node {
				if a.olderBusy.Get() {
					return ui.Spinner{Size: 11, Label: apptext.T("加载更早的消息")}
				}
				return ui.Icon(lucide.ArrowUp, 12, colors.Faint)
			}),
			core.Text{ContentFunc: func() string {
				return apptext.T("加载更早的 %d 轮", a.messagesBefore.Get())
			}, MaxLines: 1, Style: core.Style{FontSize: 11.5}, StyleFunc: ui.Colored(colors.Muted)},
		}}
}

// transcriptView shows the messages of one session, with the composer
// under them.
func (a *mobileApp) transcriptView(cx *core.Scope) core.Node {
	return core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0)}, Children: []core.Node{
		a.pageHeader(cx, a.activeTitle.Get(), "",
			a.pressIcon(lucide.FolderOpen, apptext.T("浏览文件"), 34, 16, nil, a.openSessionFiles, "mobile-files"),
			a.pressIcon(lucide.Search, apptext.T("搜索会话内容"), 34, 16, nil, func() {
				a.findText.Set("")
				a.findSelected.Set(transcriptRowKey{})
				a.findOpen.Update(func(v bool) bool { return !v })
			}, "mobile-find"),
			a.pressIcon(lucide.Ellipsis, apptext.T("会话操作"), 34, 16, nil, func() { a.actionID.Set(a.active.Get()) }, "mobile-active-actions"),
		),
		a.appNotice(cx),
		core.Show{When: func() bool { return a.transcriptErr.Get() != "" }, Then: func(cx *core.Scope) core.Node {
			return a.errorBar(cx, a.transcriptErr.Get)
		}},
		core.Show{When: func() bool { return a.sendErr.Get() != "" }, Then: func(cx *core.Scope) core.Node {
			return a.errorBar(cx, a.sendErr.Get)
		}},
		core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), Position: core.Relative}, Children: []core.Node{
			a.transcriptList(),
			core.Show{When: func() bool { return !a.atBottom.Get() && len(a.messages.Get()) > 0 }, Then: func(cx *core.Scope) core.Node {
				colors := ui.ColorsOf(cx)
				return core.View{OnPress: func(core.PressEvent) { a.scroll.ScrollToEnd(true) }, Role: core.RoleButton,
					Label: apptext.T("回到最新"), TestID: "mobile-latest",
					StyleFunc: func() core.Style {
						return core.Style{Position: core.Absolute, Right: core.Pt(14), Bottom: core.Pt(12), Direction: core.Row,
							AlignItems: core.AlignCenter, Gap: 4, Padding: core.Symmetric(6, 10), CornerRadius: 16,
							Background: colors.Light(), Transition: viewkit.PressMotion}
					},
					Children: []core.Node{
						ui.Icon(lucide.ChevronDown, 12, colors.OnLight),
						ui.Text(apptext.T("最新"), 11, ui.Medium, colors.OnLight),
					}}
			}},
		}},
		a.retryBar(cx),
		a.askBar(cx),
		a.composer(cx),
	}}
}

// errorBar is one failure line under the header: the turn's own error, or
// why the phone's send did not reach the desktop.
func (a *mobileApp) errorBar(cx *core.Scope, text func() string) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{TestID: "mobile-error", Style: core.Style{Direction: core.Row, Gap: 6, Padding: core.Symmetric(8, 14)},
		StyleFunc: func() core.Style { return core.Style{Background: ui.Alpha(colors.Danger(), 0.07)} },
		Children: []core.Node{
			ui.Icon(lucide.TriangleAlert, 12, colors.Danger),
			core.Text{ContentFunc: text, MaxLines: 3, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11},
				StyleFunc: ui.Colored(colors.Danger)},
		}}
}

// findBar searches the loaded messages of the open session.
func (a *mobileApp) findBar(cx *core.Scope, matches func() []int, selected func() int, move func(int)) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{StyleFunc: func() core.Style {
		return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Symmetric(6, 10),
			Background: colors.Surface(), Borders: core.Edges{Bottom: 1}, BorderColors: core.EdgeColors{Bottom: colors.Line()}}
	}, Children: []core.Node{
		core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
			core.Input{Value: a.findText.Get, OnChange: func(query string) {
				a.findSelected.Set(transcriptRowKey{})
				a.findText.Set(query)
			}, Placeholder: apptext.T("在这个会话里搜索"), Label: apptext.T("搜索会话内容"), TestID: "mobile-find-input",
				Style: core.Style{Height: core.Pt(36), Padding: core.Symmetric(0, 10), FontSize: 13.5, Color: colors.Text(),
					Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 9,
					PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}},
		}},
		core.Text{ContentFunc: func() string {
			if n := len(matches()); n > 0 {
				return fmt.Sprintf("%d/%d", selected()+1, n)
			}
			return apptext.T("匹配 %d 条", 0)
		}, TestID: "mobile-find-count", Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Faint)},
		a.pressIcon(lucide.ChevronUp, apptext.T("上一个匹配"), 28, 14, func() bool { return len(matches()) == 0 }, func() { move(-1) }, "mobile-find-prev"),
		a.pressIcon(lucide.ChevronDown, apptext.T("下一个匹配"), 28, 14, func() bool { return len(matches()) == 0 }, func() { move(1) }, "mobile-find-next"),
		a.pressIcon(lucide.X, apptext.T("结束搜索"), 30, 14, nil, func() {
			a.findOpen.Set(false)
			a.findText.Set("")
			a.findSelected.Set(transcriptRowKey{})
		}, "mobile-find-close"),
	}}
}

// askBar is the desktop's pending question: a turn is waiting on it, so
// the phone can answer instead of leaving it stuck.
func (a *mobileApp) askBar(cx *core.Scope) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		ask := a.ask.Get()
		if ask == nil {
			return nil
		}
		colors := ui.ColorsOf(cx)
		title := ask.Title
		if title == "" {
			title = "电脑在等你确认"
		}
		sending := a.askSending.Get()
		button := func(text string, primary bool, testID string, body map[string]any) core.Node {
			variant := ui.ButtonSecondary
			if primary {
				variant = ui.ButtonPrimary
			}
			return ui.Button{Text: text, Variant: variant, Size: ui.SizeSmall, TestID: testID,
				Disabled: func() bool { return sending },
				OnPress:  func() { a.answer(body) }}
		}
		var actions []core.Node
		switch ask.Method {
		case "confirm":
			actions = append(actions,
				button("拒绝", false, "mobile-ask-deny", map[string]any{"confirmed": false}),
				button("允许", true, "mobile-ask-allow", map[string]any{"confirmed": true}))
		case "select":
			for i, opt := range ask.Options {
				actions = append(actions, button(opt, false, fmt.Sprintf("mobile-ask-option-%d", i), map[string]any{"value": opt}))
			}
			actions = append(actions, button(apptext.T("取消"), false, "mobile-ask-cancel", map[string]any{"cancelled": true}))
		case remotewire.AskMethodBatch:
			// Several questions are the desktop's card; the phone can let
			// the request go but not answer it.
			actions = append(actions, button(apptext.T("取消"), false, "mobile-ask-cancel", map[string]any{"cancelled": true}))
		default:
			actions = append(actions, core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
				core.Input{Value: a.askText.Get, OnChange: a.askText.Set, Placeholder: apptext.T("输入回答"), Label: apptext.T("回答"), TestID: "mobile-ask-input",
					Style: core.Style{Height: core.Pt(36), Padding: core.Symmetric(0, 10), FontSize: 13.5, Color: colors.Text(),
						Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 9,
						PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}},
			}})
			actions = append(actions,
				button(apptext.T("取消"), false, "mobile-ask-cancel", map[string]any{"cancelled": true}),
				button("确定", true, "mobile-ask-send", map[string]any{"value": a.askText.GetUntracked()}))
		}
		head := []core.Node{
			ui.Icon(lucide.ShieldAlert, 14, colors.Warn),
			core.Text{Content: title, MaxLines: 2, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12.5, FontWeight: ui.Semibold},
				StyleFunc: ui.Colored(colors.Text)},
		}
		if sending {
			head = append(head, ui.Spinner{Size: 11})
		}
		children := []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7}, Children: head},
		}
		if ask.Message != "" {
			children = append(children, core.Text{Content: ask.Message, MaxLines: 4, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FontSize: 11.5, LineHeight: 16}, StyleFunc: ui.Colored(colors.Muted)})
		}
		children = append(children, core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, AlignItems: core.AlignCenter, Gap: 6},
			Children: actions})
		return core.View{TestID: "mobile-ask", StyleFunc: func() core.Style {
			return core.Style{Gap: 7, Padding: core.Symmetric(9, 12),
				Background:   ui.Alpha(colors.Warn(), 0.10),
				Borders:      core.Edges{Top: 1, Bottom: 1},
				BorderColors: core.EdgeColors{Top: ui.Alpha(colors.Warn(), 0.35), Bottom: ui.Alpha(colors.Warn(), 0.35)}}
		}, Children: children}
	})
}

// answer replies to the desktop's pending question.
func (a *mobileApp) answer(body map[string]any) {
	client := a.client
	id := a.active.GetUntracked()
	if client == nil || id == "" || a.askSending.GetUntracked() {
		return
	}
	a.askSending.Set(true)
	go func() {
		err := client.answer(id, body)
		a.cx.Post(func() {
			a.askSending.Set(false)
			if err != nil {
				a.transcriptErr.Set(remoteErrorText(err))
				return
			}
			a.ask.Set(nil)
			a.askText.Set("")
			a.refreshTranscript()
		})
	}()
}
