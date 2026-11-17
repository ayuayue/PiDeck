//go:build !js && !android && !ios

package main

// The chat: turns with their tools, the composer, and the empty state.

import (
	"fmt"
	"math"
	"path/filepath"
	"strings"
	"time"

	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// The reading width of the transcript and composer: the kit's column is
// 720 points wide, and narrower reads better on wide screens.
const (
	chatWidthMin = 520
	chatWidthMax = 1000
)

// chatPane is the conversation and its composer.
func (a *app) chatPane() core.Node {
	return core.View{Style: ui.FillRest, Children: []core.Node{
		core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			s := a.active()
			if s == nil {
				return a.welcome()
			}
			return core.View{StyleFunc: func() core.Style {
				return ui.FillRest.Merge(core.Style{Background: colors.Background(), Color: colors.Text()})
			}, Children: []core.Node{
				a.chatSurface(s),
				a.turnAxis(s),
				core.Show{When: a.chatFindOpen.Get, Then: func(cx *core.Scope) core.Node { return a.chatFindBar(s) }},
				core.Show{When: func() bool {
					return len(s.turns.Get()) == 0 && !s.loaded.Get() && s.status.Get() != statusFailed
				}, Then: func(cx *core.Scope) core.Node { return a.historySkeleton(s) }},
				core.Show{When: func() bool {
					return len(s.turns.Get()) == 0 && (s.loaded.Get() || s.status.Get() == statusFailed)
				}, Then: func(cx *core.Scope) core.Node { return a.emptyChat(s) }},
			}}
		}),
	}}
}

// contentWidth is the transcript and composer's reading width, the kit's
// default until the user narrows it.
func (a *app) contentWidth() int {
	w := a.chatWidth.Get()
	if w < chatWidthMin || w > chatWidthMax {
		w = int(chat.ContentWidth)
	}
	return w
}

// setChatWidth narrows or widens the transcript and composer, and keeps
// the choice; the kit's own width is stored as the default.
func (a *app) setChatWidth(w int) {
	if w < chatWidthMin {
		w = chatWidthMin
	}
	if w > chatWidthMax {
		w = chatWidthMax
	}
	a.chatWidth.Set(w)
	stored := w
	if w == int(chat.ContentWidth) {
		stored = 0
	}
	a.cfg.ChatWidth = stored
	if a.st != nil {
		a.st.edit(func(c *config) { c.ChatWidth = stored })
	}
}

// composerStack keeps the composer and its bars at the reading width.
func (a *app) composerStack(s *session) core.Node {
	return core.View{Style: core.Style{Width: core.Pct(100), AlignItems: core.AlignCenter}, Children: []core.Node{
		core.View{TestID: "composer-column", Style: core.Style{Width: core.Pct(100), MaxWidth: core.Pt(core.Points(a.contentWidth())), MinWidth: core.Pt(0)}, Children: []core.Node{
			a.trustBar(s), a.goalStrip(s), a.todoBar(s),
			// An ask takes the composer's place while it waits: the answer
			// is the only thing to send then.
			core.Show{
				When: func() bool { return s.showingAsk() != nil },
				Then: func(*core.Scope) core.Node { return a.askPanel(s) },
				Else: func(*core.Scope) core.Node {
					return core.View{Style: core.Style{Gap: 0}, Children: []core.Node{a.queuePanel(s), a.composer(s)}}
				},
			},
		}},
	}}
}

// transcript is the keyed list of turns, bounded to a window of the newest.
func (a *app) transcript(s *session) core.Node {
	return core.View{Style: core.Style{MinWidth: core.Pt(0), FlexShrink: 0, Width: core.Pct(100), AlignItems: core.AlignCenter}, Children: []core.Node{
		core.View{Selectable: true, TestID: "transcript-column", Style: core.Style{Width: core.Pct(100), MaxWidth: core.Pt(core.Points(a.contentWidth())), MinWidth: core.Pt(0), Gap: 48}, Children: []core.Node{
			core.Show{When: func() bool { return len(s.turns.Get()) > s.window.Get() }, Then: func(cx *core.Scope) core.Node {
				return a.loadEarlier(s)
			}},
			core.Each(func() []turn {
				turns := s.turns.Get()
				window := s.window.Get()
				start := max(0, len(turns)-window)
				list := turns[start:]
				if q := a.findQuery(); q != "" {
					kept := make([]turn, 0, len(list))
					for _, t := range list {
						if turnMatches(t, q) {
							kept = append(kept, t)
						}
					}
					list = kept
				}
				return list
			}, func(t turn) string { return t.ID }, func(cx *core.Scope, t func() turn, ix func() int) core.Node {
				// Each turn reports where it sits, so a mark on the ruler can
				// scroll to the turn it stands for.
				return core.View{OnLayout: func(b core.Bounds) {
					if s.tops == nil {
						s.tops = map[string]float64{}
					}
					s.tops[t().ID] = float64(b.Origin.Y)
				}, Children: []core.Node{a.turnView(s, t, ix)}}
			}),
		}},
	}}
}

// loadEarlier shows another page of older turns.
func (a *app) loadEarlier(s *session) core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{Style: core.Style{AlignItems: core.AlignCenter, Padding: core.Edges{Top: 2}},
		Children: []core.Node{ui.Press{OnPress: func() {
			s.window.Update(func(n int) int { return n + 24 })
		}, Label: T("加载更早的对话"), Children: []core.Node{
			core.View{StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Height: core.Pt(28), Padding: core.Symmetric(0, 12),
					CornerRadius: 14, BorderWidth: 1, BorderColor: colors.Border(), Hover: &core.Style{Background: colors.Hover()}}
			}, Children: []core.Node{
				ui.Icon(lucide.ArrowUp, 12, colors.Muted),
				ui.Text("加载更早的对话", 12, ui.Regular, colors.Muted),
			}},
		}}},
	}
}

// The ruler at the transcript's right edge: a scale of scroll positions,
// drawn across the middle of the height only, so it reads as a track
// without claiming the whole conversation.
const (
	// axisBand is the share of the height the ruler spans, centered.
	axisBand = 46
	// axisTickWidth is how long a tick grows to under the pointer, and
	// axisTickNarrow how long it rests.
	axisTickWidth  = 18
	axisTickNarrow = 6
	axisTickHit    = axisTickWidth + 4
	// axisStep is the most air one mark has above the next, and axisChrome
	// what the tab bar and padding take above the chat pane.
	axisStep   = 12
	axisChrome = 56
	// axisTickGapMin is the tightest pitch that still leaves a mark
	// pressable; closer than this, the ruler drops turns instead.
	axisTickGapMin = 4.0
)

// axisGrow eases a tick from its resting length to the long mark under the
// pointer; TransitionLayout is what animates a resize.
var axisGrow = core.Transition{Duration: 140 * time.Millisecond, Easing: core.EaseOut,
	Properties: core.TransitionLayout | core.TransitionBackground}

// planAxisTicks picks the turns that get a mark: one per turn while they fit,
// and otherwise an even sample that keeps the first and the last, so both
// ends of a long session stay a click away.
func planAxisTicks(turns int, bandHeight float64) []int {
	if turns <= 0 || bandHeight <= 0 {
		return nil
	}
	fit := int(bandHeight/axisTickGapMin) + 1
	if fit >= turns {
		marks := make([]int, turns)
		for i := range marks {
			marks[i] = i
		}
		return marks
	}
	fit = max(2, fit)
	marks := make([]int, 0, fit)
	for slot := 0; slot < fit; slot++ {
		marks = append(marks, int(math.Round(float64(slot)*float64(turns-1)/float64(fit-1))))
	}
	return marks
}

// turnAxis is the ruler at the transcript's right edge: one mark per turn
// across the middle of the height, a click scrolls to that turn, and resting
// on a mark names it.
func (a *app) turnAxis(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		turns := len(s.turns.Get())
		if turns < 3 {
			return nil
		}
		colors := ui.ColorsOf(cx)
		window := cx.Env().Window()
		pane := float64(window.Height) - axisChrome
		if pane <= 0 {
			return nil
		}
		bandHeight := pane * axisBand / 100
		shown := planAxisTicks(turns, bandHeight)
		// The marks keep a fixed pitch at most and stack as one compact
		// scale, centered in the band: four turns are four short marks
		// together, not four dashes spread over a third of the window. A
		// crowded ruler tightens the pitch instead of overflowing the band.
		pitch := math.Min(float64(axisStep), bandHeight/float64(max(1, len(shown))))
		box := core.Points(math.Max(4, pitch))
		stack := core.Points(pitch * float64(len(shown)))
		marks := make([]core.Node, 0, len(shown)+1)
		for pos, turn := range shown {
			pos, turn := pos, turn
			bar := core.View{
				OnPress: func(core.PressEvent) { a.jumpToTurnIndex(s, turn) },
				Role:    core.RoleButton, LabelFunc: func() string { return a.axisTip(s, turn) },
				TestID: fmt.Sprintf("axis-tick-%d", pos),
				StyleFunc: func() core.Style {
					// A short mark at rest; the one under the pointer grows out
					// to its full length, so the scale does not read as a picket
					// fence at rest.
					st := core.Style{Width: core.Pt(axisTickNarrow), Height: core.Pt(2.5), CornerRadius: 1.25,
						Background: colors.Faint(), Transition: axisGrow}
					if a.axisHover.Get() == pos {
						st.Width = core.Pt(axisTickWidth)
						st.Background = colors.Text()
					}
					return st
				},
			}
			marks = append(marks, core.View{
				OnMouseEnter: func(core.MouseEvent) { a.hoverAxis(pos) },
				// Leaving the box clears only its own tick, so moving from
				// one mark to the next keeps pointing at the new one
				// whichever of the two events arrives first.
				OnMouseLeave: func(core.MouseEvent) {
					if a.axisHover.GetUntracked() == pos {
						a.axisHover.Set(-1)
					}
				},
				Style: core.Style{Width: core.Pt(axisTickHit), Height: core.Pt(box), AlignItems: core.AlignCenter,
					JustifyContent: core.JustifyCenter}, Children: []core.Node{bar}})
		}
		marks = append(marks, a.axisHint(s, shown, box, pitch))
		inset := (pane - bandHeight) / 2
		top := inset + (bandHeight-float64(stack))/2
		return core.View{
			OnMouseLeave: func(core.MouseEvent) { a.axisHover.Set(-1) },
			Style: core.Style{Position: core.Absolute, Right: core.Pt(8), Width: core.Pt(axisTickHit), Height: core.Pt(stack),
				Direction: core.Column, AlignItems: core.AlignCenter, JustifyContent: core.JustifyStart,
				PointerEvents: core.PointerEventsBoxNone},
			StyleFunc: func() core.Style {
				return core.Style{Top: core.Pt(core.Points(top))}
			},
			Children: marks}
	})
}

// hoverAxis points the ruler's hint at a tick. Moving along the scale
// moves it at once; it eases in only when it was hidden, so sliding down
// the ruler does not blink.
func (a *app) hoverAxis(index int) {
	if a.axisHover.GetUntracked() == index {
		return
	}
	fresh := a.axisHover.GetUntracked() < 0
	a.axisHover.Set(index)
	if fresh {
		a.axisHintIn.Set(false)
		a.cx.AfterFunc(16*time.Millisecond, func() { a.axisHintIn.Set(true) })
	}
}

// axisHint is the summary beside the tick the pointer rests on: it sits
// just left of the ruler, on the tick's line, and takes no presses.
func (a *app) axisHint(s *session, shown []int, box core.Points, pitch float64) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		i := a.axisHover.Get()
		if i < 0 || i >= len(shown) {
			return nil
		}
		tip := a.axisTip(s, shown[i])
		if tip == "" {
			return nil
		}
		// The hint rides the tick's line inside the stack, so it never
		// drifts to another mark's height.
		centre := box/2 + core.Points(pitch*float64(i))
		top := math.Max(0, float64(centre)-14)
		return core.View{
			Style: core.Style{Position: core.Absolute, Right: core.Pt(axisTickHit + 8), Top: core.Pt(core.Points(top)),
				Width: core.Pt(260), Padding: core.Symmetric(6, 10), CornerRadius: 9, Background: colors.Surface(),
				BorderWidth: 1, BorderColor: colors.Border(), Shadows: []core.BoxShadow{ui.Shadow(0, 10, 26, 0, ui.Black(0.16))},
				PointerEvents: core.PointerEventsNone},
			StyleFunc: func() core.Style {
				st := core.Style{Opacity: core.Alpha(1), Transition: core.Transition{Duration: 120 * time.Millisecond, Easing: core.EaseOut,
					Properties: core.TransitionOpacity | core.TransitionTransform}}
				if !a.axisHintIn.Get() {
					st.Opacity = core.Alpha(0)
					st.Transform = core.Transform{TranslateY: 2}
				}
				return st
			},
			Children: []core.Node{core.Text{Content: tip, MaxLines: 3, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FontSize: 11.5, LineHeight: 16}, StyleFunc: ui.Colored(colors.Text)}},
		}
	})
}

// jumpToTurn scrolls the transcript to a fraction of its scrollable length.
func (a *app) jumpToTurn(s *session, fraction float64) {
	a.scrollToOffset(s, float64(a.scrollRoom(s))*fraction)
}

// scrollRoom is how far the transcript can scroll, 0 when it fits.
func (a *app) scrollRoom(s *session) core.Points {
	frame, ok := s.conversation.Scroll().Frame()
	content, hasContent := s.conversation.Scroll().ContentBounds()
	if !ok || !hasContent {
		return 0
	}
	if maxY := content.Size.Height - frame.Size.Height; maxY > 0 {
		return maxY
	}
	return 0
}

// scrollToOffset puts the top of the transcript at a content offset.
func (a *app) scrollToOffset(s *session, y float64) {
	room := float64(a.scrollRoom(s))
	if room <= 0 {
		return
	}
	s.conversation.Scroll().ScrollTo(core.Point{Y: core.Points(math.Min(math.Max(0, y), room))}, true)
}

// axisTip is what the ruler says over a mark: the turn it stands for, and
// the start of its prompt.
func (a *app) axisTip(s *session, i int) string {
	turns := s.turns.GetUntracked()
	if i < 0 || i >= len(turns) {
		return ""
	}
	summary := firstLine(turns[i].Prompt, 60)
	if summary == "" {
		summary = firstLine(turns[i].Final, 60)
	}
	if summary == "" {
		return T("第 %d 轮", i+1)
	}
	return T("第 %d 轮 · %s", i+1, summary)
}

// turnView is one prompt and everything pi answered.
func (a *app) turnView(s *session, t func() turn, index func() int) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		// The clock is read inside the labels that show an elapsed time,
		// never here: rebuilding the turn every second would reset the
		// disclosures inside it.
		now := func() time.Time { return a.clock.Get() }
		return chat.Turn{
			Status: func() chat.Status { return t().Status },
			// The fold row says what the process did; the duration sits at
			// the end of the turn instead, so it is not read twice.
			Summary: func() string {
				tt := t()
				var parts []string
				if tt.Plan {
					parts = append(parts, T("计划"))
				}
				if tt.Goal {
					parts = append(parts, T("目标"))
				}
				if tt.Tools > 0 {
					parts = append(parts, T("%d 个工具调用", tt.Tools))
				}
				switch tt.Status {
				case chat.Cancelled:
					parts = append(parts, T("已停止"))
				case chat.Failed:
					parts = append(parts, T("出错"))
				}
				if len(parts) == 0 {
					parts = append(parts, T("过程"))
				}
				return strings.Join(parts, " · ")
			},
			Working: func() string {
				tt := t()
				label := "正在工作"
				if tt.Noticed != "" {
					label = tt.Noticed
				}
				return label + " · " + duration(tt.elapsed(now()))
			},
			Prompt: func(cx *core.Scope) core.Node {
				return core.Dynamic(func(cx *core.Scope) core.Node {
					tt := t()
					var children []core.Node
					for _, img := range tt.Images {
						children = append(children, chat.AttachmentPreview{Label: img.Name, Image: core.ImageSource{Data: img.Data}})
					}
					if tt.Prompt != "" {
						children = append(children, core.Text{Content: tt.Prompt, Selectable: core.SelectableOn,
							Style: core.Style{FontSize: a.readingFont(), LineHeight: a.readingLine(), Color: colors.Text()}})
					}
					return core.View{Style: core.Style{Direction: core.Column, AlignItems: core.AlignEnd, Gap: 3},
						Children: []core.Node{
							core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: children},
							// When it was sent, inside the bubble's foot, as a
							// chat shows its own messages.
							core.Show{When: func() bool { return !t().Start.IsZero() }, Then: func(cx *core.Scope) core.Node {
								return ui.Tabular(core.Text{Content: clockTime(t().Start),
									Style:     core.Style{FontSize: a.readingDetailFont(), LineHeight: a.readingDetailLine()},
									StyleFunc: ui.Colored(colors.Faint)})
							}},
						}}
				})
			},
			Steps: func() []chat.Step { return a.steps(s, t()) },
			Final: func(cx *core.Scope) core.Node {
				tt := t()
				return core.View{Style: core.Style{MinWidth: core.Pt(0)}, Children: []core.Node{markdownSearchView(a.chatSearch, tt.Final, func() bool { return false }, false, a.readingFont(), a.readingLine(), core.Style{})}}
			},
			HasFinal: func() bool {
				tt := t()
				return !tt.running() && tt.Final != ""
			},
			Footer: func(cx *core.Scope) core.Node {
				// Each part watches the turn itself: a footer built once
				// would keep the state it had when the turn started.
				return core.Group{
					a.changeSummary(s, t),
					core.Show{When: func() bool { return t().Err != "" }, Then: func(cx *core.Scope) core.Node {
						tt := t()
						return a.errorRow(func() { a.retry(s, tt) }, tt.Err)
					}},
					core.Show{When: func() bool { tt := t(); return tt.Err == "" && tt.Status == chat.Failed }, Then: func(*core.Scope) core.Node {
						tt := t()
						return a.errorRow(func() { a.retry(s, tt) }, "这一轮没有完成，可以重试。")
					}},
					core.Show{When: func() bool { return t().Status == chat.Cancelled }, Then: func(*core.Scope) core.Node {
						return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7},
							Children: []core.Node{
								ui.Icon(lucide.Square, 11, colors.Faint),
								core.Text{ContentFunc: func() string { return "已停止 · 用时 " + duration(t().elapsed(now())) },
									Style: core.Style{FontSize: 12}, StyleFunc: ui.Colored(colors.Muted)},
							}}
					}},
					core.Show{When: func() bool { tt := t(); return tt.running() && tt.Noticed != "" }, Then: func(*core.Scope) core.Node {
						return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6},
							Children: []core.Node{
								ui.Spinner{Size: 11},
								core.Text{ContentFunc: func() string { return t().Noticed },
									Style: core.Style{FontSize: 11.5}, StyleFunc: ui.Colored(colors.Muted)},
							}}
					}},
				}
			},
			Actions: func(cx *core.Scope) core.Node {
				tt := t()
				var planActions []core.Node
				if tt.Plan {
					planActions = append(planActions,
						chat.IconAction{Label: T("执行计划"), Icon: lucide.Play,
							Disabled: func() bool { return t().running() || t().Final == "" },
							OnPress:  func() { a.executePlan(s, tt) }},
						chat.IconAction{Label: T("逐步执行"), Icon: lucide.ListChecks,
							Disabled: func() bool { return t().running() || len(planSteps(t().Final)) < 2 },
							OnPress:  func() { a.executePlanSteps(s, tt) }},
						chat.IconAction{Label: T("修改计划"), Icon: lucide.PencilLine,
							Disabled: func() bool { return t().Final == "" },
							OnPress:  func() { a.editPlan(s, tt) }},
					)
				}
				actions := append(planActions, []core.Node{
					chat.IconAction{Label: T("重新发送"), Icon: lucide.RefreshCw,
						Disabled: func() bool { return tt.Prompt == "" || t().running() },
						OnPress:  func() { a.resendTurn(s, tt) }},
					chat.IconAction{Label: T("复制提问"), Icon: lucide.Quote, Disabled: func() bool { return tt.Prompt == "" },
						OnPress: func() { a.copyText(tt.Prompt, "提问") }},
					chat.IconAction{Label: T("把提问放回输入框"), Icon: lucide.PencilLine, Disabled: func() bool { return tt.Prompt == "" },
						OnPress: func() {
							s.draft.Set(tt.Prompt)
							a.toast(ui.ToastInfo, "提问已放回输入框", "可以改完再发。")
						}},
					chat.IconAction{Label: T("复制回复"), Icon: lucide.Copy, OnPress: func() {
						text := tt.Final
						if text == "" {
							for i := len(tt.Steps) - 1; i >= 0; i-- {
								if tt.Steps[i].Text != "" {
									text = tt.Steps[i].Text
									break
								}
							}
						}
						a.copyText(text, "回复")
					}},
					chat.IconAction{Label: T("收藏这条回复"), Icon: lucide.Star, TestID: "turn-favorite",
						OnPress: func() { a.favoriteReply(s, t()) }},
					chat.IconAction{Label: T("从这里分叉"), Icon: lucide.GitBranch, Disabled: func() bool { return tt.Prompt == "" },
						OnPress: func() { a.forkSession(s, tt.ID) }},
					chat.IconAction{Label: T("重试"), Icon: lucide.RefreshCw, OnPress: func() { a.retry(s, tt) }},
				}...)
				// The reply's own line closes the row: when it came back, how
				// long it took and which model answered.
				return core.Group(append(actions, a.turnMeta(t, now)))
			},
			ShowActions: func() bool {
				tt := t()
				return !tt.running() && (tt.Final != "" || tt.Err != "")
			},
			Conversation: s.conversation.Kit(),
		}
	})
}

// turnMeta ends a finished reply: when it came back, how long the turn took
// and the model that gave it. PiDeck puts the same line at the end of its
// actions row, where the eye already is.
func (a *app) turnMeta(t func() turn, now func() time.Time) core.Node {
	return core.Show{
		When: func() bool { tt := t(); return !tt.running() && (!tt.End.IsZero() || tt.Model != "") },
		Then: func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			tt := t()
			faint := core.Style{FontSize: a.readingDetailFont(), LineHeight: a.readingDetailLine(), FontVariant: core.FontTabularNums}
			var row []core.Node
			dot := func() {
				if len(row) > 0 {
					row = append(row, core.Text{Content: "·", Style: faint, StyleFunc: ui.Colored(colors.Faint)})
				}
			}
			if !tt.End.IsZero() {
				row = append(row, core.Text{Content: clockTime(tt.End), Style: faint, StyleFunc: ui.Colored(colors.Faint)})
			}
			if d := tt.elapsed(now()); d >= time.Second {
				dot()
				row = append(row, ui.Icon(lucide.Clock, 11, colors.Faint),
					core.Text{Content: duration(d), Style: faint, StyleFunc: ui.Colored(colors.Faint)})
			}
			if tt.Model != "" {
				dot()
				row = append(row, core.Text{Content: tt.Model, Style: core.Style{FontSize: a.readingDetailFont(),
					LineHeight: a.readingDetailLine(), FontFamily: monoFont()}, StyleFunc: ui.Colored(colors.Faint)})
			}
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4,
				Padding: core.Edges{Left: 4}}, Children: row}
		},
	}
}

// steps is a turn's work: one step per assistant message, streaming or
// committed. The step an answer streams into keeps its ID when it commits,
// so the same row becomes the finished one instead of being rebuilt.
func (a *app) steps(s *session, tt turn) []chat.Step {
	out := make([]chat.Step, 0, len(tt.Steps)+1)
	for _, st := range tt.Steps {
		out = append(out, a.stepView(s, tt, st, false))
	}
	if tt.running() {
		out = append(out, a.stepView(s, tt, turnStep{ID: stepID(&tt, tt.Msgs), Start: tt.Start}, true))
	}
	return out
}

// stepView is one assistant message: what it thought, what it ran, what it
// said.
func (a *app) stepView(s *session, tt turn, st turnStep, live bool) chat.Step {
	return chat.Step{ID: st.ID, Message: func(cx *core.Scope) core.Node {
		return core.Dynamic(func(cx *core.Scope) core.Node {
			var children []core.Node
			thinking, tools := st.Thinking, st.Tools
			text := st.Text
			if live {
				thinking = s.streamThinking.Get()
				tools = s.liveTools.Get()
				text = s.streamText.Get()
			}
			if st.Note != "" {
				children = append(children, a.noteBlock(st.Note, st.Text))
			}
			if strings.TrimSpace(thinking) != "" {
				children = append(children, a.thinkRow(s, st, thinking, live))
			}
			if len(tools) > 0 {
				children = append(children, a.toolRows(s, tools))
			}
			if text != "" {
				children = append(children, markdownSearchView(a.chatSearch, text, func() bool { return live }, live, a.readingFont(), a.readingLine(), core.Style{}))
			}
			if len(children) == 0 {
				return nil
			}
			return core.View{Style: core.Style{Gap: 12, MinWidth: core.Pt(0)}, Children: children}
		})
	}}
}

// thinkingTone is the identity color of the thinking row: indigo, apart
// from the accent, so the reasoning reads as a process of its own.
func thinkingTone(cx *core.Scope) core.Color {
	if c, ok := cx.Palette().Colors["thinking"]; ok {
		return c
	}
	return ui.ColorsOf(cx).Muted()
}

// thinkRow is what pi reasoned, folded to one line until opened. It sits a
// step below the answer: row-sized text in the muted ink, a mono preview
// for the folded line, and the duration in the faint detail size. While it
// streams it stays open and counts.
func (a *app) thinkRow(s *session, st turnStep, thinking string, live bool) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		s.uiSeq.Get() // redraw when a row opens or closes
		key := s.ID + "/think/" + st.ID
		open := s.thinkingRowOpen(key, live)
		started := st.Start
		if started.IsZero() {
			started = a.cx.Now()
		}
		label := "思考"
		if live {
			label = "思考中"
		}
		rowSize, detailSize := a.readingRowFont(), a.readingDetailFont()
		header := []core.Node{
			ui.Icon(lucide.Brain, 13, func() core.Color { return thinkingTone(cx) }),
			core.Text{Content: label, MaxLines: 1,
				Style: core.Style{FontSize: rowSize, FontWeight: ui.Medium, FlexShrink: 0}, StyleFunc: ui.Colored(colors.Muted)},
		}
		if live {
			header = append(header, ui.Tabular(core.Text{Content: "· " + duration(a.cx.Now().Sub(started)), MaxLines: 1,
				Style: core.Style{FontSize: detailSize, FlexShrink: 0}, StyleFunc: ui.Colored(colors.Faint)}))
		}
		header = append(header, ui.IconOf(func() *core.SVG {
			if open {
				return lucide.ChevronDown()
			}
			return lucide.ChevronRight()
		}, 11.5, colors.Faint))
		if open {
			header = append(header, core.View{Style: core.Style{FlexGrow: 1}})
		} else {
			header = append(header, core.Text{Content: shorten(thinking, 160), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: detailSize,
					LineHeight: a.readingDetailLine(), FontFamily: monoFont()},
				StyleFunc: ui.Colored(colors.Faint)})
		}
		if live {
			header = append(header, ui.Spinner{Size: 10})
		}
		body := []core.Node{core.View{
			OnPress: func(core.PressEvent) { s.toggleThink(key, live) },
			Role:    core.RoleButton, Label: label,
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinHeight: core.Pt(26), Padding: core.Symmetric(0, 2),
					Hover: &core.Style{Background: colors.Hover()}, CornerRadius: 5}
			},
			Children: header,
		}}
		if open {
			body = append(body, core.View{Style: core.Style{MinWidth: core.Pt(0), Margin: core.Edges{Left: 18},
				Padding: core.Edges{Left: 12, Top: 4, Bottom: 2}, Borders: core.Edges{Left: 2},
				BorderColors: core.EdgeColors{Left: colors.Now().Line}}, Children: []core.Node{
				markdownSearchView(a.chatSearch, thinking, func() bool { return live }, false, rowSize, a.readingRowLine(),
					core.Style{Color: colors.Muted(), FontWeight: core.FontWeight(350)}),
			}})
		}
		return core.View{Style: core.Style{MinWidth: core.Pt(0), Gap: 2}, Children: body}
	})
}

// toolRows is a message's tool calls in the order it made them.
func (a *app) toolRows(s *session, tools []toolRun) core.Node {
	rows := make([]core.Node, 0, len(tools))
	for _, run := range tools {
		rows = append(rows, a.toolRow(s, run))
	}
	return core.View{Style: core.Style{Gap: 6, MinWidth: core.Pt(0)}, Children: rows}
}

// changeSummary lists the files a turn edited or wrote, folded to one
// line until opened; a path opens in the built-in editor.
func (a *app) changeSummary(s *session, t func() turn) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		s.uiSeq.Get() // redraw when the summary opens or closes
		tt := t()
		changes := turnChanges(tt)
		if len(changes) == 0 {
			return nil
		}
		key := s.ID + "/changes/" + tt.ID
		open := s.toolOpen(key, false)
		added, removed := 0, 0
		for _, c := range changes {
			added += c.Added
			removed += c.Removed
		}
		rowSize, detailSize := a.readingRowFont(), a.readingDetailFont()
		header := []core.Node{
			ui.Icon(lucide.FileDiff, 13, colors.Muted),
			core.Text{Content: fmt.Sprintf("修改 %d 个文件", len(changes)),
				Style: core.Style{FontSize: rowSize, FontWeight: ui.Medium}, StyleFunc: ui.Colored(colors.Muted)},
		}
		if added > 0 || removed > 0 {
			header = append(header,
				ui.Tabular(core.Text{Content: fmt.Sprintf("+%d", added), Style: core.Style{FontFamily: monoFont(), FontSize: detailSize},
					StyleFunc: ui.Colored(colors.Up)}),
				ui.Tabular(core.Text{Content: fmt.Sprintf("−%d", removed), Style: core.Style{FontFamily: monoFont(), FontSize: detailSize},
					StyleFunc: ui.Colored(colors.Danger)}))
		}
		header = append(header, ui.IconOf(func() *core.SVG {
			if open {
				return lucide.ChevronDown()
			}
			return lucide.ChevronRight()
		}, 11.5, colors.Faint))
		rows := []core.Node{core.View{
			OnPress: func(core.PressEvent) { s.toggleOpen(key) },
			Role:    core.RoleButton, Label: T("修改摘要"), TestID: "turn-changes",
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinHeight: core.Pt(24),
					Padding: core.Symmetric(0, 4), CornerRadius: 5, Hover: &core.Style{Background: colors.Hover()}}
			},
			Children: header,
		}}
		if open {
			for i, c := range changes {
				change := c
				row := core.View{
					OnPress: func(core.PressEvent) { a.openChangeFile(s, change.Path) },
					Role:    core.RoleButton, Label: T("打开 ") + change.Path, TestID: fmt.Sprintf("turn-change-%d", i),
					StyleFunc: func() core.Style {
						return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(24),
							Padding: core.Symmetric(0, 6), CornerRadius: 5, Hover: &core.Style{Background: colors.Hover()}}
					},
					Children: []core.Node{
						core.Text{Content: change.Path, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: monoFont(),
								FontSize: a.readingDetailFont()},
							StyleFunc: ui.Colored(colors.Muted)},
					},
				}
				if change.Added > 0 || change.Removed > 0 {
					row.Children = append(row.Children,
						ui.Tabular(core.Text{Content: fmt.Sprintf("+%d", change.Added), Style: core.Style{FontFamily: monoFont(), FontSize: detailSize},
							StyleFunc: ui.Colored(colors.Up)}),
						ui.Tabular(core.Text{Content: fmt.Sprintf("−%d", change.Removed), Style: core.Style{FontFamily: monoFont(), FontSize: detailSize},
							StyleFunc: ui.Colored(colors.Danger)}))
				}
				rows = append(rows, row)
			}
		}
		return core.View{Style: core.Style{Gap: 1, MinWidth: core.Pt(0)}, Children: rows}
	})
}

// openChangeFile opens a path a tool changed, resolving it against the
// session's folder when it is relative.
func (a *app) openChangeFile(s *session, path string) {
	if s == nil || path == "" || strings.HasSuffix(path, "…") {
		return
	}
	if i := strings.Index(path, " 等 "); i > 0 {
		path = path[:i]
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(s.WS, path)
	}
	a.openEditorFile(s.WS, path)
}

// noteBlock is a system note, such as a compaction summary.
func (a *app) noteBlock(title, body string) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		children := []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7}, Children: []core.Node{
				ui.Icon(lucide.Minimize2, 13, colors.Faint),
				core.Text{Content: title, Style: core.Style{FontSize: a.readingRowFont(), FontWeight: ui.Medium},
					StyleFunc: ui.Colored(colors.Muted)},
			}},
		}
		if body != "" {
			children = append(children, markdownSized(body, func() bool { return false }, false, a.readingRowFont(), a.readingRowLine(), core.Style{Color: colors.Muted()}))
		}
		return core.View{StyleFunc: func() core.Style {
			return core.Style{Gap: 8, Padding: core.Symmetric(8, 12), CornerRadius: ui.RadiusControl,
				BorderWidth: 1, BorderColor: colors.Border(), Background: colors.Inset()}
		}, Children: children}
	})
}

// toolRow is one tool call: its verb and target, a live line while it
// runs, and its output or diff once the user opens it. While a call runs
// its row opens by itself, so output arrives in place; the user's own
// choice then wins. The state lives on the session, keyed by the call, so
// rebuilding the turn never closes a row the user opened.
func (a *app) toolRow(s *session, run toolRun) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		s.uiSeq.Get() // redraw when a row opens or closes
		key := s.ID + "/" + run.CallID
		running := run.Status == chat.Running
		open := s.toolOpen(key, running)
		body := toolBodyText(run)
		rowSize, detailSize := a.readingRowFont(), a.readingDetailFont()
		header := []core.Node{
			ui.IconOf(func() *core.SVG { return toolIcon(run) }, 14, func() core.Color {
				switch {
				case run.IsError:
					return colors.Danger()
				case running:
					return colors.Info()
				}
				return colors.Muted()
			}),
			core.Text{Content: run.Action, MaxLines: 1,
				Style:     core.Style{FontSize: rowSize, FontWeight: ui.Medium, FlexShrink: 0},
				StyleFunc: ui.Colored(colors.Muted)},
			core.Text{Content: shorten(run.Detail, 140), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: monoFont(), FontSize: detailSize},
				StyleFunc: ui.Colored(colors.Faint)},
		}
		if run.Added > 0 || run.Removed > 0 {
			header = append(header, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, FlexShrink: 0},
				Children: []core.Node{
					ui.Tabular(core.Text{Content: fmt.Sprintf("+%d", run.Added), Style: core.Style{FontFamily: monoFont(), FontSize: detailSize},
						StyleFunc: ui.Colored(colors.Up)}),
					ui.Tabular(core.Text{Content: fmt.Sprintf("−%d", run.Removed), Style: core.Style{FontFamily: monoFont(), FontSize: detailSize},
						StyleFunc: ui.Colored(colors.Danger)}),
				}})
		}
		if len(run.Nested) > 0 {
			header = append(header, core.Text{Content: fmt.Sprintf("内含 %d 次调用", len(run.Nested)), MaxLines: 1,
				Style: core.Style{FontFamily: monoFont(), FontSize: detailSize, FlexShrink: 0}, StyleFunc: ui.Colored(colors.Faint)})
		}
		switch {
		case running:
			header = append(header, ui.Spinner{Size: 10})
		case run.DurationMs > 0:
			header = append(header, ui.Tabular(core.Text{Content: fmt.Sprintf("%d ms", run.DurationMs),
				Style: core.Style{FontFamily: monoFont(), FontSize: detailSize, FlexShrink: 0}, StyleFunc: ui.Colored(colors.Faint)}))
		}
		if run.IsError {
			header = append(header, core.Text{Content: "失败", Style: core.Style{FontSize: detailSize, FontWeight: ui.Medium, FlexShrink: 0},
				StyleFunc: ui.Colored(colors.Danger)})
		}
		if body != "" {
			header = append(header, ui.IconOf(func() *core.SVG {
				if open {
					return lucide.ChevronDown()
				}
				return lucide.ChevronRight()
			}, 12, colors.Faint))
		}
		rows := []core.Node{core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(28),
			Padding: core.Symmetric(2, 6), MinWidth: core.Pt(0)}, Children: header}}
		if open && body != "" {
			rows = append(rows, core.View{Style: core.Style{MinWidth: core.Pt(0), MaxHeight: core.Pt(320), Borders: core.Edges{Top: 1},
				BorderColors: core.EdgeColors{Top: colors.Now().Line}}, Children: []core.Node{
				core.Scroll{Style: core.Style{MinWidth: core.Pt(0)}, Children: []core.Node{
					core.View{Style: core.Style{Padding: core.Symmetric(8, 10), Gap: 4}, Children: a.toolBodyNodes(cx, run)},
				}},
			}})
		}
		return core.View{
			OnPress: func(core.PressEvent) {
				if body == "" {
					return
				}
				s.toggleOpen(key)
			},
			Role: core.RoleButton, Label: strings.TrimSpace(run.Action + " " + run.Detail),
			StyleFunc: func() core.Style {
				st := core.Style{MinWidth: core.Pt(0), CornerRadius: 8, Background: core.Transparent, Overflow: core.Hidden}
				if body != "" {
					st.Hover = &core.Style{Background: ui.Mix(colors.Background(), colors.Text(), 0.04)}
				}
				if open {
					st.Background = ui.Mix(colors.Background(), colors.Text(), 0.03)
				}
				return st
			},
			Children: rows,
		}
	})
}

// toolIcon is the glyph of what a tool does.
func toolIcon(run toolRun) *core.SVG {
	switch {
	case run.Status == chat.Running:
		return lucide.Loader()
	case run.IsError:
		return lucide.CircleAlert()
	}
	switch run.Name {
	case "bash":
		return lucide.Terminal()
	case "read":
		return lucide.FileText()
	case "write":
		return lucide.FilePlus()
	case "edit":
		return lucide.Pencil()
	case "grep", "find":
		return lucide.Search()
	case "ls":
		return lucide.Folder()
	case "web_search", "websearch":
		return lucide.Globe()
	case "fetch_content", "webfetch", "web_fetch":
		return lucide.Link()
	case "todo", "todowrite":
		return lucide.ListChecks()
	case "task", "agent":
		return lucide.Bot()
	case "codemode":
		return lucide.Code()
	}
	return lucide.Wrench()
}

// toolBodyText is what a row can show at all: output, a diff, or nested
// calls.
func toolBodyText(run toolRun) string {
	if run.Diff != "" {
		return run.Diff
	}
	if run.Output != "" {
		return run.Output
	}
	if len(run.Nested) > 0 {
		return strings.Join(run.Nested, "\n")
	}
	return ""
}

// toolBodyNodes is an open row's body: a diff colored by its signs, or the
// output as it came.
func (a *app) toolBodyNodes(cx *core.Scope, run toolRun) []core.Node {
	colors := ui.ColorsOf(cx)
	size, rowLine := a.readingDetailFont(), a.readingDetailLine()
	if run.Diff != "" {
		var lines []core.Node
		for _, line := range strings.Split(run.Diff, "\n") {
			c := colors.Code()
			bg := core.Transparent
			switch {
			case strings.HasPrefix(line, "+"):
				c, bg = colors.Up(), ui.Alpha(colors.Up(), 0.08)
			case strings.HasPrefix(line, "-"):
				c, bg = colors.Danger(), ui.Alpha(colors.Danger(), 0.07)
			case strings.HasPrefix(line, "@"):
				c = colors.Faint()
			}
			ink := c
			lines = append(lines, core.Text{Content: line, Selectable: core.SelectableOn,
				Style:     core.Style{FontFamily: monoFont(), FontSize: size, LineHeight: rowLine, Background: bg, Width: core.Pct(100)},
				StyleFunc: ui.Colored(func() core.Color { return ink })})
		}
		return lines
	}
	var nodes []core.Node
	for _, line := range run.Nested {
		nodes = append(nodes, core.Text{Content: "· " + line, Selectable: core.SelectableOn,
			Style: core.Style{FontFamily: monoFont(), FontSize: size, LineHeight: rowLine}, StyleFunc: ui.Colored(colors.Faint)})
	}
	out := run.Output
	if out == "" {
		out = "（没有输出）"
	}
	nodes = append(nodes, core.Text{Content: out, Selectable: core.SelectableOn,
		Style: core.Style{FontFamily: monoFont(), FontSize: size, LineHeight: rowLine}, StyleFunc: ui.Colored(colors.Code)})
	return nodes
}

// errorRow is a failure and how to try again.
func (a *app) errorRow(retry func(), text string) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return core.View{StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10, Padding: core.Symmetric(10, 12),
				CornerRadius: ui.RadiusControl, Background: ui.Alpha(colors.Danger(), 0.07),
				BorderWidth: 1, BorderColor: ui.Alpha(colors.Danger(), 0.28)}
		}, Children: []core.Node{
			ui.Icon(lucide.CircleAlert, 16, colors.Danger),
			core.Text{Content: text, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12.5, LineHeight: 19},
				StyleFunc: ui.Colored(colors.Text)},
			ui.Button{Text: T("重试"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: retry},
		}}
	})
}

// composerAccessory is the row of controls inside the card: where the
// session runs, what this prompt asks for, and the model that answers it.
func (a *app) composerAccessory(s *session) chat.View {
	return func(cx *core.Scope) core.Node {
		return core.Dynamic(func(cx *core.Scope) core.Node {
			// Follow the mode, the backend and the agent's own changes, which
			// live outside signals.
			s.agentMode.Get()
			s.uiSeq.Get()
			var parts []core.Node
			parts = append(parts, a.composerBackendPicker(s), a.composerAddMenu(s))
			if chip := a.composerModeChip(s); chip != nil {
				parts = append(parts, chip)
			}
			switch {
			case modeOn(s, modeImage):
				parts = append(parts, a.composerImageOptions(s))
			case backendOf(s) == "acp":
				parts = append(parts, a.acpBadge(s))
			default:
				parts = append(parts, hintOf(func() string {
					if m := s.model.Get(); m.ID != "" {
						return T("模型 · %s", modelLabel(m))
					}
					return T("选择模型")
				}, a.modelMenu(s, s.modelOpen)))
				parts = append(parts, a.effortPicker(s))
			}
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, MinWidth: core.Pt(0),
				FlexShrink: 1, Overflow: core.Hidden}, Children: parts}
		})
	}
}

// enhanceDraft asks the prompt tool to rewrite the draft.
func (a *app) enhanceDraft(s *session) {
	if a.aiBusy.GetUntracked() != "" {
		return
	}
	draft := strings.TrimSpace(s.draft.GetUntracked())
	if draft == "" {
		return
	}
	if !a.toolConfigured("prompt") {
		a.toast(ui.ToastInfo, T("还没有配置提示词增强的模型"), T("到 设置 → 模型 → 工具模型 里选供应商和模型。"))
		return
	}
	a.aiBusy.Set("prompt")
	go func() {
		text, err := a.complete("prompt",
			"你是提示词润色助手。把用户的草稿改写成更清晰、具体、可执行的提示词；保留原意、语言和约束，不添加无关要求。只输出改写后的提示词。",
			draft, 900)
		a.cx.Post(func() {
			a.aiBusy.Set("")
			if err != nil {
				a.toast(ui.ToastError, T("提示词增强失败"), firstLine(err.Error(), 160))
				return
			}
			s.draft.Set(cleanLLMText(text))
			a.toast(ui.ToastSuccess, T("提示词已增强"), "")
		})
	}()
}

// predictDraft asks the prediction tool for the draft's next sentence.
func (a *app) predictDraft(s *session) {
	if a.aiBusy.GetUntracked() != "" {
		return
	}
	draft := s.draft.GetUntracked()
	if strings.TrimSpace(draft) == "" {
		return
	}
	if !a.toolConfigured("predict") {
		a.toast(ui.ToastInfo, T("还没有配置输入预测的模型"), T("到 设置 → 模型 → 工具模型 里选供应商和模型。"))
		return
	}
	a.aiBusy.Set("predict")
	go func() {
		text, err := a.complete("predict",
			"续写用户正在输入的消息，只写接下来的一个短句或半句，与已有文字自然衔接；不要重复已有内容，不要解释。只输出续写部分。",
			draft, 160)
		a.cx.Post(func() {
			a.aiBusy.Set("")
			if err != nil {
				a.toast(ui.ToastError, T("输入预测失败"), firstLine(err.Error(), 160))
				return
			}
			text = strings.TrimSpace(cleanLLMText(text))
			if text == "" {
				return
			}
			s.draft.Set(strings.TrimRight(draft, " \n") + " " + text)
			a.toast(ui.ToastSuccess, T("已续写"), T("可以继续改。"))
		})
	}()
}

// composerTrailing is the tools, the attach button, the context gauge and
// the way messages are sent.
func (a *app) composerTrailing(s *session) chat.View {
	return func(cx *core.Scope) core.Node {
		return core.Dynamic(func(cx *core.Scope) core.Node {
			s.sendMode.Get()
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 2}, Children: []core.Node{
				a.aiToolButton(s, "prompt", lucide.WandSparkles, "增强提示词", "prompt-enhance", func() { a.enhanceDraft(s) }),
				a.aiToolButton(s, "predict", lucide.Sparkles, "续写", "prompt-predict", func() { a.predictDraft(s) }),
				a.attachButton(s),
				a.contextMeterNode(s),
				a.sendMenu(s),
			}}
		})
	}
}

// contextValue describes the context window's use.
func (a *app) contextValue(s *session) string {
	st := s.stats.Get()
	if st.ContextWindow > 0 {
		return fmt.Sprintf("%s / %s (%.0f%%)", tokens(st.ContextTokens), tokens(st.ContextWindow), st.ContextPercent)
	}
	m := s.model.Get()
	u := s.usage.Get()
	if m.ContextWindow > 0 && u.Total > 0 {
		return fmt.Sprintf("%s / %s", tokens(u.Total), tokens(m.ContextWindow))
	}
	return "未测量"
}

// contextFraction is how full the context is, negative when unknown.
func (a *app) contextFraction(s *session) float64 {
	st := s.stats.Get()
	if st.ContextWindow > 0 {
		return min(1, float64(st.ContextTokens)/float64(st.ContextWindow))
	}
	m := s.model.Get()
	u := s.usage.Get()
	if m.ContextWindow > 0 && u.Total > 0 {
		return min(1, float64(u.Total)/float64(m.ContextWindow))
	}
	return -1
}

// composerFooter is the row under the card: where the session runs, which
// agent it carries, what is failing, and the usage panel.
func (a *app) composerFooter(s *session) chat.View {
	return func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, MinWidth: core.Pt(0)}, Children: []core.Node{
			core.Show{When: func() bool { return s.readySig.Get() }, Then: func(*core.Scope) core.Node {
				return core.View{TestID: "pi-ready", Label: T("pi 就绪"),
					StyleFunc: func() core.Style {
						return core.Style{Width: core.Pt(6), Height: core.Pt(6), CornerRadius: 3, Background: colors.Up()}
					}}
			}},
			hintOf(func() string { return T("项目 · 点一下换") }, a.projectMenu(s, s.projectOpen)),
			a.personaChip(s),
			core.Show{When: func() bool { return s.notice.Get() != "" }, Then: func(cx *core.Scope) core.Node {
				return core.Text{ContentFunc: func() string { return shorten(s.notice.Get(), 40) }, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FlexShrink: 1, FontFamily: monoFont(), FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)}
			}},
			core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}},
			hintOf(func() string { return T("用量与上下文") }, a.usageMenu(s, s.usageOpen)),
		}}
	}
}

// attachments previews pasted images above the input.
func (a *app) attachments(s *session) chat.View {
	return func(cx *core.Scope) core.Node {
		images := s.images.Get()
		var children []core.Node
		for i, img := range images {
			idx := i
			children = append(children, chat.AttachmentPreview{
				Label: img.Name, RemoveLabel: "移除图片", Image: core.ImageSource{Data: img.Data},
				OnRemove: func() {
					s.images.Update(func(list []promptImage) []promptImage {
						if idx < len(list) {
							return append(append([]promptImage(nil), list[:idx]...), list[idx+1:]...)
						}
						return list
					})
				},
			})
		}
		return core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: children}
	}
}

// historySkeleton stands in for a session's transcript while pi reads
// its file, so an opening history does not look empty.
func (a *app) historySkeleton(s *session) core.Node {
	colors := ui.ColorsOf(a.cx)
	block := func(i int) core.Node {
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignStart, Gap: 12}, Children: []core.Node{
			ui.SkeletonBlock{Width: core.Pt(24), Height: core.Pt(24), Round: true, Index: i * 4},
			core.View{Style: core.Style{FlexGrow: 1, Gap: 8}, Children: []core.Node{
				ui.SkeletonBlock{Width: core.Pct(42), Height: core.Pt(9), Index: i*4 + 1},
				ui.SkeletonBlock{Width: core.Pct(92), Height: core.Pt(8), Index: i*4 + 2},
				ui.SkeletonBlock{Width: core.Pct(68), Height: core.Pt(8), Index: i*4 + 3},
			}},
		}}
	}
	return core.View{TestID: "history-skeleton", Accessible: true, Label: T("正在读取历史会话"),
		Style: core.Style{Position: core.Absolute, Top: core.Pt(0), Left: core.Pt(0), Right: core.Pt(0),
			AlignItems: core.AlignCenter, PointerEvents: core.PointerEventsBoxNone},
		StyleFunc: func() core.Style { return core.Style{Bottom: core.Pt(s.conversation.ComposerHeight())} },
		Children: []core.Node{core.View{Style: core.Style{FlexGrow: 1, Width: core.Pct(100), MaxWidth: core.Pt(core.Points(a.contentWidth())), MinHeight: core.Pt(0),
			JustifyContent: core.JustifyCenter, Padding: core.Symmetric(32, 24), Gap: 22}, Children: []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7}, Children: []core.Node{
				ui.Spinner{Size: 11, Label: T("正在读取历史会话")},
				ui.Text("正在读取历史会话…", 10.5, ui.Regular, colors.Faint),
			}},
			block(0), block(1), block(2),
		}}},
	}
}

// emptyChat is shown over a conversation with no turns yet.
func (a *app) emptyChat(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		ws := a.workspaceOf(s.WS)
		name := "这个项目"
		if ws != nil {
			name = ws.label()
		}
		return core.View{Style: core.Style{Position: core.Absolute, Top: core.Pt(0), Left: core.Pt(0), Right: core.Pt(0),
			AlignItems: core.AlignCenter, PointerEvents: core.PointerEventsBoxNone},
			StyleFunc: func() core.Style { return core.Style{Bottom: core.Pt(s.conversation.ComposerHeight())} },
			Children: []core.Node{
				core.View{Style: core.Style{FlexGrow: 1, Width: core.Pct(100), MaxWidth: core.Pt(640), MinHeight: core.Pt(0)}, Children: []core.Node{
					core.Scroll{Style: core.Style{FlexGrow: 1, MinHeight: core.Pt(0)}, Children: []core.Node{
						core.View{Style: core.Style{FlexGrow: 1, JustifyContent: core.JustifyCenter, Padding: core.Symmetric(24, 20), Gap: 22,
							MinHeight: core.Pt(0)}, Children: []core.Node{
							core.View{Style: core.Style{AlignItems: core.AlignCenter, Gap: 10}, Children: []core.Node{
								core.Image{Source: core.ImageSource{Data: logoPNG}, ResizeMode: core.Contain, Label: "PiDeck",
									Style: core.Style{Width: core.Pt(56), Height: core.Pt(56), CornerRadius: 16}},
								core.Text{Content: T("在 %s 里做点什么", name), Style: core.Style{FontSize: 20, FontWeight: ui.Semibold, LineHeight: 27},
									StyleFunc: ui.Colored(colors.Text)},
								core.Text{ContentFunc: func() string {
									m := s.model.Get()
									model := T("本机 pi")
									if m.ID != "" {
										model = m.shortLabel()
									}
									return T("%s · 会话保存在应用自己的目录", model)
								}, Style: core.Style{FontSize: 12, TextAlign: core.TextAlignCenter}, StyleFunc: ui.Colored(colors.Muted)},
							}},
							core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 10}, Children: []core.Node{
								a.suggestion(T("看看这个项目"), T("先看看当前目录里有什么，用一句话概括它是做什么的。")),
								a.suggestion(T("跑一遍测试"), T("找到这个项目的测试命令，跑一遍，把失败项列出来。")),
								a.suggestion(T("解释一处代码"), T("挑这个项目里最关键的一个文件，解释它的结构。")),
								a.suggestion(T("修一个小问题"), T("看看最近的改动，指出最可能出问题的地方并修掉。")),
							}},
							core.Text{Content: T("Enter 发送 · Shift+Enter 换行 · ⌘K 命令面板"),
								Style: core.Style{FontFamily: monoFont(), FontSize: 10, TextAlign: core.TextAlignCenter}, StyleFunc: ui.Colored(colors.Faint)},
						}},
					}},
				}},
			}}
	})
}

// suggestion fills the draft with a prompt.
func (a *app) suggestion(title, prompt string) core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{Style: core.Style{Width: core.Pct(48), FlexGrow: 1}, Children: []core.Node{
		core.View{
			OnPress: func(core.PressEvent) {
				if s := a.active(); s != nil {
					s.draft.Set(prompt)
				}
			},
			Role: core.RoleButton, Label: title,
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Column, Gap: 4, Padding: core.All(12), CornerRadius: ui.RadiusControl,
					Background: colors.Surface(), BorderWidth: 1, BorderColor: colors.Border(),
					Hover: &core.Style{Background: colors.Hover(), BorderColor: colors.Text()}}
			},
			Children: []core.Node{
				ui.Text(title, 12.5, ui.Semibold, colors.Text),
				core.Text{Content: prompt, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Muted)},
			},
		},
	}}
}

// welcome is shown when there is no session at all.
func (a *app) welcome() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		hasWorkspace := len(a.workspaces.Get()) > 0
		sub := T("先添加一个项目文件夹，再开会话。")
		if hasWorkspace {
			sub = T("打开一个会话，或者新建一个。")
		}
		return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Padding: core.All(32)},
			StyleFunc: func() core.Style { return core.Style{Background: colors.Background()} },
			Children: []core.Node{
				core.View{Style: core.Style{AlignItems: core.AlignCenter, Gap: 14, MaxWidth: core.Pt(420)}, Children: []core.Node{
					core.Image{Source: core.ImageSource{Data: logoPNG}, ResizeMode: core.Contain, Label: "PiDeck",
						Style: core.Style{Width: core.Pt(64), Height: core.Pt(64), CornerRadius: 18}},
					core.Text{Content: "PiDeck Lite", Style: core.Style{FontFamily: monoFont(), FontSize: 22, FontWeight: ui.Bold, LetterSpacing: 0.4},
						StyleFunc: ui.Colored(colors.Text)},
					core.Text{Content: sub, Style: core.Style{FontSize: 13, TextAlign: core.TextAlignCenter, LineHeight: 20}, StyleFunc: ui.Colored(colors.Muted)},
					core.View{Style: core.Style{Direction: core.Row, Gap: 8}, Children: []core.Node{
						core.Dynamic(func(*core.Scope) core.Node {
							if hasWorkspace {
								return ui.Button{Text: T("新建会话"), Variant: ui.ButtonPrimary, TestID: "welcome-primary", OnPress: func() {
									path := a.activeWS.Get()
									if path == "" {
										if list := a.workspaces.Get(); len(list) > 0 {
											path = list[0].Path
										}
									}
									a.newSession(path)
								}}
							}
							return ui.Button{Text: T("添加工作区"), Variant: ui.ButtonPrimary, TestID: "welcome-primary", OnPress: func() { a.pickNative("workspace") }}
						}),
						ui.Button{Text: T("直接对话"), Variant: ui.ButtonSecondary, TestID: "welcome-chat", OnPress: func() { a.openChat() }},
						ui.Button{Text: T("导入会话"), Variant: ui.ButtonSecondary, TestID: "welcome-secondary", OnPress: func() { a.openImportDialog() }},
					}},
					core.Text{Content: T("NSGo 原生窗口 · 不是 Electron · 会话由本机 pi 的 RPC 模式驱动"),
						Style: core.Style{FontFamily: monoFont(), FontSize: 10, TextAlign: core.TextAlignCenter, LineHeight: 16}, StyleFunc: ui.Colored(colors.Faint)},
				}},
			}}
	})
}

// clockTime is when a prompt went out or an answer came back: the date and
// the time, so a session read days later still reads right.
func clockTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format("01-02 15:04")
}

// duration renders an elapsed time for a turn.
func duration(d time.Duration) string {
	if d < time.Second {
		return "0s"
	}
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%dm%02ds", int(d.Minutes()), int(d.Seconds())%60)
	}
	return fmt.Sprintf("%dh%02dm", int(d.Hours()), int(d.Minutes())%60)
}

// keep base imported for menu items built here as the UI grows.
var _ = base.ReasonSelect

// todoBar is the agent's task list above the composer: a line saying what
// waits that opens to the items. It stays out of the way when there is no
// list, and a dismissed strip stays away until the list changes.
func (a *app) todoBar(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		_ = s.uiSeq.Get()
		colors := ui.ColorsOf(cx)
		items := a.sessionTodos(s)
		if len(items) == 0 {
			return nil
		}
		fingerprint := todoFingerprint(items)
		if s.todoDismissed != "" && s.todoDismissed == fingerprint {
			return nil
		}
		open := s.todoOpen.Get()
		current := currentTodoText(items)
		head := core.View{
			OnPress: func(core.PressEvent) { s.todoOpen.Update(func(v bool) bool { return !v }) },
			Role:    core.RoleButton, Label: T("待办"), TestID: "todo-bar",
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(32),
					Padding: core.Symmetric(0, 10), CornerRadius: 8, BorderWidth: 1, BorderColor: colors.Border(),
					Background: ui.Alpha(colors.Surface(), 1), Hover: &core.Style{Background: colors.Hover()},
					Transition: pressMotion}
			},
			Children: []core.Node{
				ui.Icon(lucide.ListChecks, 13, colors.Muted),
				ui.Text(T("待办"), 11.5, ui.Medium, colors.Text),
				core.Text{ContentFunc: func() string { return todoProgressText(a.sessionTodos(s)) },
					MaxLines: 1, Style: core.Style{FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
				core.Text{Content: firstLine(current, 60), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11, TextAlign: core.TextAlignEnd},
					StyleFunc: ui.Colored(colors.Muted)},
				ui.IconOf(func() *core.SVG {
					if open {
						return lucide.ChevronDown()
					}
					return lucide.ChevronUp()
				}, 12, colors.Faint),
				// Closing the strip leaves the list with the agent; it comes
				// back when the list changes.
				core.View{OnPress: func(core.PressEvent) {
					s.todoDismissed = todoFingerprint(a.sessionTodos(s))
					a.bumpSessionUI(s)
				}, Role: core.RoleButton, Label: T("关闭待办"), TestID: "todo-dismiss",
					StyleFunc: func() core.Style {
						return core.Style{Width: core.Pt(20), Height: core.Pt(20), CornerRadius: 5, AlignItems: core.AlignCenter,
							JustifyContent: core.JustifyCenter, Hover: &core.Style{Background: colors.Pressed()}}
					}, Children: []core.Node{ui.Icon(lucide.X, 11, colors.Faint)}},
			},
		}
		if !open {
			return core.View{Style: core.Style{Padding: core.Edges{Left: 12, Right: 12, Bottom: 6}}, Children: []core.Node{head}}
		}
		var rows []core.Node
		for _, it := range items {
			item := it
			icon := lucide.Circle
			tint := colors.Faint
			weight := ui.Regular
			switch item.Status {
			case "completed":
				icon, tint = lucide.CircleCheck, colors.Up
			case "in_progress":
				icon, tint, weight = lucide.Loader, colors.Accent, ui.Medium
			case "cancelled":
				icon, tint = lucide.CircleX, colors.Faint
			}
			rows = append(rows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7,
				MinHeight: core.Pt(24), Padding: core.Edges{Left: 10, Right: 8}}, Children: []core.Node{
				ui.Icon(icon, 12, tint),
				core.Text{Content: item.Text, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11.5, LineHeight: 16},
					StyleFunc: func() core.Style {
						color := colors.Text()
						if item.Status == "completed" || item.Status == "cancelled" {
							color = colors.Faint()
						}
						return core.Style{Color: color, FontWeight: weight}
					}},
			}})
		}
		return core.View{Style: core.Style{Padding: core.Edges{Left: 12, Right: 12, Bottom: 6}, Gap: 3}, Children: []core.Node{
			head,
			core.Scroll{Style: core.Style{MaxHeight: core.Pt(168)}, Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Column, Gap: 1}, Children: rows},
			}},
		}}
	})
}

// streamCaret is the block that pulses at the end of a growing answer.
func streamCaret(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	s := core.Style{Width: core.Pt(7), Height: core.Pt(15), Margin: core.Edges{Left: 2}, CornerRadius: 2}
	if !ui.ReduceMotion(cx) {
		s.Animation = core.KeyframeAnimation{Keyframes: core.KeyframesPulse, Duration: 900 * time.Millisecond}
	}
	return core.View{Style: s, StyleFunc: ui.Filled(colors.Text)}
}
