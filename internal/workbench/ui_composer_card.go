//go:build !js && !android && !ios

package workbench

// The chat surface: the transcript with the composer floating over it, and
// the composer card itself. The card is the app's own, not the kit's glass:
// an opaque surface (a scrolled turn can never read through it), a hairline
// that shows on every platform, and one place for the text size setting.

import (
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// chatScroll is the transcript's scroll state: whether it follows the last
// turn, how tall the floating composer is, and the scroll view the ruler
// and the axis use.
type chatScroll struct {
	scroll    *core.Ref
	following *core.Signal[bool]
	composer  *core.Signal[core.Points]
	lastY     core.Points
	// kit is the chat kit's copy of the follow state: a turn asks it
	// whether to stay unfolded, and pauses it when a row opens. It moves
	// with this one.
	kit *chat.ConversationState
}

// newChatScroll makes a state that follows the latest turn.
func newChatScroll(cx *core.Scope) *chatScroll {
	return &chatScroll{scroll: &core.Ref{}, following: core.NewSignal(cx, true),
		composer: core.NewSignal(cx, core.Points(140)), kit: chat.NewConversationState(cx)}
}

// Kit is the chat kit's copy of the follow state, for its turns.
func (c *chatScroll) Kit() *chat.ConversationState { return c.kit }

// AtLatest reports whether the transcript follows its end.
func (c *chatScroll) AtLatest() bool { return c.following.Get() }

// JumpToLatest returns to the end and follows it again.
func (c *chatScroll) JumpToLatest() {
	c.following.Set(true)
	c.scroll.ScrollToEnd(false)
	c.kit.JumpToLatest()
}

// Scroll is the transcript's scroll view.
func (c *chatScroll) Scroll() *core.Ref { return c.scroll }

// ComposerHeight is the room the floating composer takes at the bottom.
func (c *chatScroll) ComposerHeight() core.Points { return c.composer.Get() }

// measured records the composer's height after a layout, and only when it
// changed: a layout that measured the same height must not start another.
func (c *chatScroll) measured(b core.Bounds) {
	if c.composer.GetUntracked() != b.Size.Height {
		c.composer.Set(b.Size.Height)
	}
}

// scrolled follows the user: moving up leaves the end, and reaching it
// follows again. The content growing under a following view does not count.
func (c *chatScroll) scrolled(e core.ScrollEvent) {
	end := e.Offset.Y+e.Size.Height >= e.ContentSize.Height-2
	switch {
	case end:
		c.following.Set(true)
		c.kit.JumpToLatest()
	case e.Offset.Y < c.lastY-1:
		c.following.Set(false)
	}
	c.lastY = e.Offset.Y
}

// grown keeps a following transcript at its end.
func (c *chatScroll) grown(core.Bounds) {
	if c.following.GetUntracked() {
		c.scroll.ScrollToEnd(false)
	}
}

// chatSurface shows the centered composer before the first turn and docks
// it over the transcript afterward. Both placements use the reading width.
// The dock's measured height reserves space at the end of the transcript.
func (a *app) chatSurface(cx *core.Scope, s *session, selection *chatSelection) core.Node {
	scroll := s.conversation.Scroll()
	composer := func() core.Points { return s.conversation.ComposerHeight() }
	size := core.NewSignal(cx, core.Size{})
	column := func() core.Length { return a.chatColumnWidth(size.Get().Width) }
	start := core.NewMemo(cx, func() bool {
		return len(s.turns.Get()) == 0 && (s.loaded.Get() || s.status.Get() == statusFailed)
	}).Get
	var editor core.Ref
	// Moving the mounted input preserves its native caret, focus, and draft.
	stack := core.NewHolder(cx, func(*core.Scope) core.Node { return a.composerStack(s, column, &editor) })
	return core.View{TestID: "transcript", Style: ui.FillRest, OnLayout: func(b core.Bounds) {
		selection.resized(b)
		size.Set(b.Size)
	}, Children: []core.Node{
		core.Scroll{Ref: scroll, OnScroll: func(e core.ScrollEvent) {
			if e.Offset.Y != s.conversation.lastY {
				selection.clear()
			}
			s.conversation.scrolled(e)
		}, TestID: "chat-transcript",
			EdgeEffects: core.EdgeEffects{Bottom: core.EdgeEffectSoft},
			Behavior:    core.ScrollBehavior{KeyboardDismissMode: core.KeyboardDismissInteractive},
			Style:       ui.FillRest,
			Children: []core.Node{
				core.View{OnLayout: s.conversation.grown, StyleFunc: func() core.Style {
					return core.Style{Width: core.Pct(100), MinWidth: core.Pt(0), FlexShrink: 0, AlignItems: core.AlignCenter,
						Padding: core.Edges{Top: 22, Right: chatSidePadding, Left: chatSidePadding, Bottom: composer() + 30}}
				}, Children: []core.Node{a.transcript(s, selection, column)}},
			}},
		// What scrolls under the card fades into it, so the card's edges
		// never cut a line of text.
		core.View{EdgeBar: core.EdgeBar{Scroll: scroll, Side: core.SideBottom}, PointerEvents: core.PointerEventsNone,
			Style: core.Style{Position: core.Absolute, Left: core.Pt(0), Right: core.Pt(0), Bottom: core.Pt(0)},
			StyleFunc: func() core.Style {
				if start() {
					return core.Style{Height: core.Pt(0)}
				}
				return core.Style{Height: core.Pt(max(0, composer()-6))}
			}},
		core.Show{When: func() bool { return !start() && !s.conversation.AtLatest() }, Then: func(cx *core.Scope) core.Node {
			return a.jumpToLatest(s)
		}},
		core.Show{When: start,
			Then: func(*core.Scope) core.Node {
				return a.emptyChat(s, stack.Place(), &editor, column, func() core.Points { return size.Get().Height })
			},
			Else: func(*core.Scope) core.Node {
				return core.View{PointerEvents: core.PointerEventsBoxNone, OnLayout: s.conversation.measured,
					Style: core.Style{Position: core.Absolute, Left: core.Pt(0), Right: core.Pt(0), Bottom: core.Pt(0),
						AlignItems: core.AlignCenter, Padding: core.Edges{Right: chatSidePadding, Bottom: 8, Left: chatSidePadding}},
					Children: []core.Node{stack.Place()}}
			}},
		a.chatSelectionAction(selection),
	}}
}

// jumpToLatest scrolls back to the newest turn, above the composer.
func (a *app) jumpToLatest(s *session) core.Node {
	button := base.Button{Label: apptext.T("跳到最新消息"), OnPress: func(core.PressEvent) { s.conversation.JumpToLatest() },
		Style: core.Style{Width: core.Pt(32), Height: core.Pt(32), CornerRadius: 16, AlignItems: core.AlignCenter,
			JustifyContent: core.JustifyCenter},
		StyleFunc: func() core.Style {
			colors := ui.ColorsOf(a.cx)
			return core.Style{Background: ui.Alpha(colors.Surface(), 1), BorderWidth: 1, BorderColor: ui.Mix(colors.Border(), colors.Text(), 0.10),
				Shadows: []core.BoxShadow{ui.Shadow(0, 2, 8, 0, ui.Black(0.10))}, Hover: &core.Style{Background: colors.Hover()},
				FocusVisible: ui.FocusRing(a.cx, 2)}
		},
		Children: []core.Node{ui.Icon(lucide.ArrowDown, 16, ui.ColorsOf(a.cx).Text)}}
	return core.View{PointerEvents: core.PointerEventsBoxNone,
		Style: core.Style{Position: core.Absolute, Left: core.Pt(0), Right: core.Pt(0), AlignItems: core.AlignCenter},
		StyleFunc: func() core.Style {
			return core.Style{Bottom: core.Pt(s.conversation.ComposerHeight() + 14)}
		},
		Children: []core.Node{hintOf(func() string { return apptext.T("跳到最新消息") }, button)}}
}

// composerSuggestion is a row of the composer's @ list.
type composerSuggestion struct {
	base.SuggestItem
	Icon func() *core.SVG
}

// composer is the input card and its footer, floating under the transcript.
func (a *app) composer(s *session, ref *core.Ref) core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		font := a.composerFont()
		line := a.composerLine()
		height := core.NewSignal(cx, max(core.Points(48), line))
		focused, dragging := core.NewSignal(cx, false), core.NewSignal(cx, false)
		controlsWidth := core.NewSignal(cx, core.Points(0))
		trailingWidth := core.NewSignal(cx, core.Points(0))
		empty := func() bool { return strings.TrimSpace(s.draft.Get()) == "" }
		imageBusy := func() bool { return a.aiBusy.Get() == "image" }
		shell := func() (string, bool) {
			if s.agentMode.Get() == modeImage {
				return "", false
			}
			return shellDraft(s.draft.Get())
		}
		canSend := func() bool {
			if a.composerBlocked(s) {
				return false
			}
			if script, ok := shell(); ok {
				return script != "" && len(s.images.Get()) == 0
			}
			return !empty() && !imageBusy()
		}
		send := func() {
			if canSend() {
				a.send()
			}
		}
		suggest, listed := core.NewSuggest(cx, core.SuggestOptions{}), core.NewSignal(cx, false)
		var shown []composerSuggestion
		editor := base.Input{Ref: ref, Value: s.draft.Get, OnChange: func(text string) {
			s.draft.Set(text)
			// Writing the first words is what engages a blank session: pi boots
			// while the prompt is still being typed, and its own controls (the
			// thinking levels, the model list) appear before the send.
			if strings.TrimSpace(text) != "" && a.lazySession(s) {
				a.ensureEngine(s, nil)
			}
		}, Multiline: true, SubmitBehavior: core.SubmitBehaviorSubmit,
			Label: apptext.T("消息"), PlaceholderFunc: a.composerPlaceholder(s), TestID: "composer", Suggest: suggest,
			OnSubmit: func(string) { send() },
			OnPaste: func(e core.PasteEvent) {
				for _, f := range e.Files {
					if strings.HasPrefix(f.MIME, "image/") && len(f.Data) > 0 {
						a.addImage(s, remotewire.Image{Data: f.Data, MimeType: f.MIME, Name: f.Name})
					}
				}
				for _, uri := range e.URIs {
					a.dropFiles(s, []string{uri})
				}
			},
			OnFocus: func() { focused.Set(true) },
			OnBlur:  func() { focused.Set(false) },
			OnContentSizeChange: func(size core.Size) {
				height.Set(min(10*line, max(core.Points(48), max(line, size.Height))))
			},
			Style: core.Style{Padding: core.Edges{Top: 4, Right: 14, Left: 14}, MinHeight: core.Pt(line + 4),
				FontSize: font, LineHeight: line, TextAlignVertical: core.TextAlignVerticalTop},
			StyleFunc: func() core.Style {
				return core.Style{Height: core.Pt(height.Get() + 4), Color: colors.Text(), PlaceholderColor: colors.Muted(),
					SelectionColor: cx.Palette().Selection, CaretColor: colors.Accent()}
			},
			Role: core.RoleCombobox, Expanded: listed.Get,
		}
		var body []core.Node
		body = append(body, core.Show{When: func() bool { return len(s.images.Get()) > 0 }, Then: func(*core.Scope) core.Node {
			return core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6, Padding: core.Edges{Right: 10, Bottom: 6, Left: 10}},
				Children: []core.Node{core.Func(a.attachments(s))}}
		}})
		body = append(body, editor)
		body = append(body, ui.SuggestList{Suggest: suggest, Placement: core.PlaceTop, Label: apptext.T("文件"), TestID: "composer-suggestions",
			Items: func(query string) []base.SuggestItem {
				shown = a.composerSuggestions(s, query)
				out := make([]base.SuggestItem, len(shown))
				for i, row := range shown {
					out[i] = row.SuggestItem
				}
				return out
			},
			Leading: func(_ base.SuggestItem, i int) core.Node {
				if i < len(shown) && shown[i].Icon != nil {
					return ui.IconOf(shown[i].Icon, 15, colors.Muted)
				}
				return nil
			},
			OnOpen: func() { listed.Set(true) }, OnClose: func() { listed.Set(false) }})
		body = append(body, core.View{OnLayout: func(b core.Bounds) { controlsWidth.Set(b.Size.Width) },
			Style: core.Style{Position: core.Relative, Direction: core.Row, Wrap: core.Wrap, MinWidth: core.Pt(0), Margin: core.Edges{Top: 8},
				Padding: core.Symmetric(0, 10), AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), AlignItems: core.AlignCenter, Gap: 4},
					Children: []core.Node{core.Func(a.composerAccessory(s))}},
				core.View{OnLayout: func(b core.Bounds) { trailingWidth.Set(b.Size.Width) },
					Style: core.Style{Direction: core.Row, FlexShrink: 0, AlignItems: core.AlignCenter, Gap: 4}, Children: []core.Node{
						core.Func(a.composerTrailing(s)),
						core.Dynamic(func(cx *core.Scope) core.Node {
							if s.retryPending() {
								return composerPill(cx, apptext.T("重试中"), func() bool { return true },
									func() core.Color { return colors.Hover() }, func() core.Color { return colors.Muted() }, func() {})
							}
							if s.busy() && empty() {
								return composerPill(cx, apptext.T("停止"), nil, func() core.Color { return ui.Alpha(colors.Danger(), 0.14) },
									func() core.Color { return colors.Danger() }, func() { a.stop(s) })
							}
							label := apptext.T("发送")
							if _, ok := shell(); ok {
								label = apptext.T("运行命令")
							}
							if s.filesLoading() {
								label = apptext.T("正在读取")
							}
							return composerPill(cx, label, func() bool { return !canSend() }, func() core.Color {
								if canSend() {
									return colors.AccentFill()
								}
								return colors.Hover()
							}, func() core.Color {
								if canSend() {
									return colors.OnAccent()
								}
								return colors.Muted()
							}, send)
						}),
					}},
				core.View{TestID: "composer-model-anchor", StyleFunc: func() core.Style {
					st := core.Style{MinWidth: core.Pt(0), AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
						PointerEvents: core.PointerEventsBoxNone}
					if controlsWidth.Get() < 560 {
						// Stay in the normal flow when a drawer or a narrow window
						// leaves too little room between attachments and Send.
						st.Width = core.Pct(100)
						st.Padding = core.Edges{Top: 4}
						return st
					}
					st.Position = core.Absolute
					st.Top, st.Left, st.Right, st.Bottom = core.Pt(0), core.Pt(0), core.Pt(0), core.Pt(0)
					st.Padding = core.Symmetric(0, trailingWidth.Get()+8)
					return st
				},
					Children: []core.Node{core.Func(a.composerModelControls(s))}},
			}})
		card := core.View{TestID: "composer-card", Style: core.Style{MinWidth: core.Pt(0), MinHeight: core.Pt(112), Padding: core.Symmetric(10, 0), CornerRadius: 20,
			BorderWidth: 1, FlexShrink: 0, Transition: viewkit.PressMotion},
			StyleFunc: func() core.Style {
				surface := ui.Alpha(colors.Surface(), 1)
				if dragging.Get() {
					surface = ui.Mix(surface, colors.Text(), 0.05)
				}
				border := colors.Border()
				switch {
				case dragging.Get():
					border = ui.Alpha(colors.Accent(), 0.8)
				case focused.Get():
					border = ui.Mix(colors.Border(), colors.Accent(), 0.5)
				}
				return core.Style{Background: surface, BorderColor: border,
					Shadows: []core.BoxShadow{ui.Shadow(0, 2, 10, 0, ui.Black(0.06))}}
			}, Children: body}
		card.OnFileDragEnter = func() { dragging.Set(true) }
		card.OnFileDragLeave = func() { dragging.Set(false) }
		card.OnFileDrop = func(uris []string) { dragging.Set(false); a.dropFiles(s, uris) }
		return core.View{Style: core.Style{MinWidth: core.Pt(0), FlexShrink: 0}, Children: []core.Node{
			card,
			core.View{Style: core.Style{Direction: core.Row, MinWidth: core.Pt(0), Height: core.Pt(28),
				Padding: core.Edges{Top: 4, Right: 10, Left: 10}, AlignItems: core.AlignCenter, Gap: 2},
				Children: []core.Node{core.Func(a.composerFooter(s))}},
		}}
	})
}

// composerPill is the compact Send or Stop action, disabled while it
// cannot run.
func composerPill(cx *core.Scope, label string, disabled func() bool, background, foreground func() core.Color, press func()) core.Node {
	return base.Button{Label: label, Disabled: disabled, OnPress: func(core.PressEvent) { press() },
		Style: core.Style{Height: core.Pt(28), Padding: core.Symmetric(0, 12), FlexShrink: 0, CornerRadius: 8,
			AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Disabled: &core.Style{Cursor: core.CursorDefault}},
		StyleFunc: func() core.Style {
			return core.Style{Background: background(), Hover: &core.Style{Opacity: core.Alpha(0.9)},
				Active: &core.Style{Opacity: core.Alpha(0.8)}, FocusVisible: ui.FocusRing(cx, 2)}
		},
		Children: []core.Node{core.Text{Content: label, Style: core.Style{FontSize: 13, FontWeight: ui.Medium},
			StyleFunc: ui.Colored(foreground)}}}
}

// composerPlaceholder is the field's prompt while it is empty.
func (a *app) composerPlaceholder(s *session) func() string {
	return func() string {
		mode := s.agentMode.Get()
		switch {
		case mode == modeImage:
			return apptext.T("描述要画的画面…")
		case s.busy() && deliveryFor(s.backend, s.sendMode.Get()) == deliveryFollowUp:
			return apptext.T("运行中：回车排到这一轮结束后")
		case s.busy():
			return apptext.T("运行中：回车插入引导，或点停止")
		case backendOf(s) == "acp" && !s.readySig.Get():
			return apptext.T("正在启动 agent…")
		case !s.readySig.Get():
			return apptext.T("正在启动 pi…")
		case mode == modePlan:
			return apptext.T("写下要计划的事…")
		case mode == modeGoal:
			return apptext.T("写下目标，它会自己往下做…")
		}
		return apptext.T("给 pi 发消息…")
	}
}

// composerSuggestions is the @ list for the query at the caret.
func (a *app) composerSuggestions(s *session, query string) []composerSuggestion {
	files := mentionMatches(a.workspaceFiles(s.WS), query, 8)
	rows := make([]composerSuggestion, 0, len(files))
	for _, rel := range files {
		rows = append(rows, composerSuggestion{SuggestItem: base.SuggestItem{ID: rel, Label: rel, Insert: "@" + rel + " "}, Icon: lucide.File})
	}
	return rows
}
