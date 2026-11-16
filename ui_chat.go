package main

// The chat: turns with their tools, the composer, and the empty state.

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/base/diagram"
	"github.com/nsgo-dev/nsgo/base/formula"
	"github.com/nsgo-dev/nsgo/base/textview"
	"github.com/nsgo-dev/nsgo/base/textview/highlight"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// The reading width of the transcript and composer: the kit's column is
// 720 points wide, and narrower reads better on wide screens.
const (
	chatWidthMin = 520
	chatWidthMax = 720
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
				chat.FloatingConversation{
					State:     s.conversation,
					JumpLabel: T("跳到最新消息"),
					TestID:    "transcript",
					Children:  []core.Node{a.transcript(s)},
					Composer:  []core.Node{a.composerStack(s)},
				},
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
			a.trustBar(s), a.todoBar(s), a.composer(s),
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
				return a.turnView(s, t, ix)
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

// axisTicks is the turns the ruler marks: every one of a short session,
// and an even sample of a long one, so the ticks stay apart.
func axisTicks(n int) []int {
	const most = 24
	if n <= 0 {
		return nil
	}
	if n <= most {
		out := make([]int, n)
		for i := range out {
			out[i] = i
		}
		return out
	}
	out := make([]int, most)
	for i := range out {
		out[i] = i * (n - 1) / (most - 1)
	}
	return out
}

// turnAxis is the ruler at the transcript's right edge: one tick per
// turn, and a click scrolls to where that tick stands.
func (a *app) turnAxis(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		ticks := axisTicks(len(s.turns.Get()))
		if len(ticks) < 3 {
			return nil
		}
		colors := ui.ColorsOf(cx)
		var marks []core.Node
		for j, i := range ticks {
			j, i := j, i
			marks = append(marks, core.View{
				OnPress: func(core.PressEvent) { a.jumpToTurn(s, float64(j)/float64(len(ticks)-1)) },
				Role:    core.RoleButton, Label: T("跳到第 %d 轮", i+1),
				TestID: fmt.Sprintf("turn-tick-%d", j),
				StyleFunc: func() core.Style {
					return core.Style{Width: core.Pt(9), Height: core.Pt(4), CornerRadius: 2, Background: colors.Faint(),
						Hover: &core.Style{Background: colors.Text()}}
				},
			})
		}
		return core.View{Style: core.Style{Position: core.Absolute, Right: core.Pt(3), Width: core.Pt(12),
			Direction: core.Column, AlignItems: core.AlignCenter, JustifyContent: core.JustifySpaceBetween,
			PointerEvents: core.PointerEventsBoxNone},
			StyleFunc: func() core.Style {
				return core.Style{Top: core.Pt(24), Bottom: core.Pt(s.conversation.ComposerHeight() + 16)}
			},
			Children: marks}
	})
}

// jumpToTurn scrolls the transcript to a fraction of its scrollable
// length, where the ruler's tick stands.
func (a *app) jumpToTurn(s *session, fraction float64) {
	ref := s.conversation.Scroll()
	frame, ok := ref.Frame()
	content, hasContent := ref.ContentBounds()
	if !ok || !hasContent {
		return
	}
	maxY := content.Size.Height - frame.Size.Height
	if maxY <= 0 {
		return
	}
	ref.ScrollTo(core.Point{Y: core.Points(float64(maxY) * fraction)}, true)
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
			Summary: func() string {
				tt := t()
				parts := []string{"用时 " + duration(tt.elapsed(now()))}
				if tt.Tools > 0 {
					parts = append(parts, fmt.Sprintf("%d 个工具调用", tt.Tools))
				}
				switch tt.Status {
				case chat.Cancelled:
					parts[0] = "已停止 · " + parts[0]
				case chat.Failed:
					parts[0] = "出错 · " + parts[0]
				}
				summary := strings.Join(parts, " · ")
				if tt.Plan {
					summary = T("计划") + " · " + summary
				}
				return summary
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
							Style: core.Style{FontSize: 13, LineHeight: 20, Color: colors.Text()}})
					}
					return core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: children}
				})
			},
			Steps: func() []chat.Step { return a.steps(s, t()) },
			Final: func(cx *core.Scope) core.Node {
				tt := t()
				return core.View{Style: core.Style{MinWidth: core.Pt(0)}, Children: []core.Node{markdownSearchView(a.chatSearch, tt.Final, func() bool { return false }, false)}}
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
				return core.Group(append(planActions, []core.Node{
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
					chat.IconAction{Label: T("从这里分叉"), Icon: lucide.GitBranch, Disabled: func() bool { return tt.Prompt == "" },
						OnPress: func() { a.forkSession(s, tt.ID) }},
					chat.IconAction{Label: T("重试"), Icon: lucide.RefreshCw, OnPress: func() { a.retry(s, tt) }},
				}...))
			},
			ShowActions: func() bool {
				tt := t()
				return !tt.running() && (tt.Final != "" || tt.Err != "")
			},
			Conversation: s.conversation,
		}
	})
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
				children = append(children, noteBlock(st.Note, st.Text))
			}
			if strings.TrimSpace(thinking) != "" {
				children = append(children, a.thinkRow(s, st, thinking, live))
			}
			if len(tools) > 0 {
				children = append(children, a.toolRows(s, tools))
			}
			if text != "" {
				children = append(children, markdownSearchView(a.chatSearch, text, func() bool { return live }, live))
			}
			if len(children) == 0 {
				return nil
			}
			return core.View{Style: core.Style{Gap: 12, MinWidth: core.Pt(0)}, Children: children}
		})
	}}
}

// thinkRow is what pi reasoned, folded to one line until opened. While it
// streams it stays open and counts; once the message is done it folds to a
// summary the user can reopen.
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
			label = "思考中 · " + duration(a.cx.Now().Sub(started))
		}
		header := []core.Node{
			ui.IconOf(func() *core.SVG {
				if open {
					return lucide.ChevronDown()
				}
				return lucide.ChevronRight()
			}, 11, colors.Faint),
			core.Text{ContentFunc: func() string { return label }, MaxLines: 1,
				Style: core.Style{FontSize: 12, FlexShrink: 0}, StyleFunc: ui.Colored(colors.Muted)},
			core.Text{ContentFunc: func() string {
				if open {
					return ""
				}
				return shorten(thinking, 90)
			}, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11.5, FontFamily: ui.Mono},
				StyleFunc: ui.Colored(colors.Faint)},
		}
		if live {
			header = append(header, ui.Spinner{Size: 10})
		}
		body := []core.Node{core.View{
			OnPress: func(core.PressEvent) { s.toggleThink(key, live) },
			Role:    core.RoleButton, Label: label,
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinHeight: core.Pt(24), Padding: core.Symmetric(0, 2),
					Hover: &core.Style{Background: colors.Hover()}, CornerRadius: 5}
			},
			Children: header,
		}}
		if open {
			body = append(body, core.View{Style: core.Style{MinWidth: core.Pt(0), Padding: core.Edges{Left: 17, Top: 2},
				Borders: core.Edges{Left: 1}, BorderColors: core.EdgeColors{Left: colors.Now().Line}}, Children: []core.Node{
				markdownSearchView(a.chatSearch, thinking, func() bool { return live }, false),
			}})
		}
		return core.View{Style: core.Style{MinWidth: core.Pt(0), Gap: 4}, Children: body}
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
		header := []core.Node{
			ui.Icon(lucide.FileDiff, 12, colors.Muted),
			core.Text{Content: fmt.Sprintf("修改 %d 个文件", len(changes)), Style: core.Style{FontSize: 12},
				StyleFunc: ui.Colored(colors.Muted)},
		}
		if added > 0 || removed > 0 {
			header = append(header,
				core.Text{Content: fmt.Sprintf("+%d", added), Style: core.Style{FontFamily: ui.Mono, FontSize: 10.5},
					StyleFunc: ui.Colored(colors.Up)},
				core.Text{Content: fmt.Sprintf("−%d", removed), Style: core.Style{FontFamily: ui.Mono, FontSize: 10.5},
					StyleFunc: ui.Colored(colors.Danger)})
		}
		header = append(header, ui.IconOf(func() *core.SVG {
			if open {
				return lucide.ChevronDown()
			}
			return lucide.ChevronRight()
		}, 11, colors.Faint))
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
							Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: ui.Mono, FontSize: 11},
							StyleFunc: ui.Colored(colors.Muted)},
					},
				}
				if change.Added > 0 || change.Removed > 0 {
					row.Children = append(row.Children,
						core.Text{Content: fmt.Sprintf("+%d", change.Added), Style: core.Style{FontFamily: ui.Mono, FontSize: 10},
							StyleFunc: ui.Colored(colors.Up)},
						core.Text{Content: fmt.Sprintf("−%d", change.Removed), Style: core.Style{FontFamily: ui.Mono, FontSize: 10},
							StyleFunc: ui.Colored(colors.Danger)})
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
func noteBlock(title, body string) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		children := []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7}, Children: []core.Node{
				ui.Icon(lucide.Minimize2, 12, colors.Faint),
				ui.Text(title, 12, ui.Medium, colors.Muted),
			}},
		}
		if body != "" {
			children = append(children, markdownView(body, func() bool { return false }, false))
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
		header := []core.Node{
			ui.IconOf(func() *core.SVG { return toolIcon(run) }, 13, func() core.Color {
				switch {
				case run.IsError:
					return colors.Danger()
				case running:
					return colors.Accent()
				}
				return colors.Muted()
			}),
			core.Text{Content: run.Action, MaxLines: 1, Style: core.Style{FontSize: 12.5, FontWeight: ui.Semibold, FlexShrink: 0},
				StyleFunc: ui.Colored(colors.Text)},
			core.Text{Content: shorten(run.Detail, 120), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: ui.Mono, FontSize: 11.5},
				StyleFunc: ui.Colored(colors.Muted)},
		}
		if run.Added > 0 || run.Removed > 0 {
			header = append(header, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, FlexShrink: 0},
				Children: []core.Node{
					core.Text{Content: fmt.Sprintf("+%d", run.Added), Style: core.Style{FontFamily: ui.Mono, FontSize: 10.5},
						StyleFunc: ui.Colored(colors.Up)},
					core.Text{Content: fmt.Sprintf("−%d", run.Removed), Style: core.Style{FontFamily: ui.Mono, FontSize: 10.5},
						StyleFunc: ui.Colored(colors.Danger)},
				}})
		}
		if len(run.Nested) > 0 {
			header = append(header, core.Text{Content: fmt.Sprintf("内含 %d 次调用", len(run.Nested)), MaxLines: 1,
				Style: core.Style{FontFamily: ui.Mono, FontSize: 10, FlexShrink: 0}, StyleFunc: ui.Colored(colors.Faint)})
		}
		switch {
		case running:
			header = append(header, ui.Spinner{Size: 10})
		case run.DurationMs > 0:
			header = append(header, core.Text{Content: fmt.Sprintf("%d ms", run.DurationMs),
				Style: core.Style{FontFamily: ui.Mono, FontSize: 10, FlexShrink: 0}, StyleFunc: ui.Colored(colors.Faint)})
		}
		if run.IsError {
			header = append(header, core.Text{Content: "失败", Style: core.Style{FontSize: 10.5, FontWeight: ui.Medium, FlexShrink: 0},
				StyleFunc: ui.Colored(colors.Danger)})
		}
		if body != "" {
			header = append(header, ui.IconOf(func() *core.SVG {
				if open {
					return lucide.ChevronDown()
				}
				return lucide.ChevronRight()
			}, 11, colors.Faint))
		}
		rows := []core.Node{core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(28),
			Padding: core.Symmetric(2, 9), MinWidth: core.Pt(0)}, Children: header}}
		if open && body != "" {
			rows = append(rows, core.View{Style: core.Style{MinWidth: core.Pt(0), MaxHeight: core.Pt(320), Borders: core.Edges{Top: 1},
				BorderColors: core.EdgeColors{Top: colors.Now().Line}}, Children: []core.Node{
				core.Scroll{Style: core.Style{MinWidth: core.Pt(0)}, Children: []core.Node{
					core.View{Style: core.Style{Padding: core.Symmetric(8, 10), Gap: 4}, Children: toolBodyNodes(cx, run)},
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
				st := core.Style{MinWidth: core.Pt(0), CornerRadius: 9, BorderWidth: 1, BorderColor: colors.Now().Line,
					Background: ui.Mix(colors.Background(), colors.Text(), 0.03), Overflow: core.Hidden}
				if body != "" {
					st.Hover = &core.Style{Background: ui.Mix(colors.Background(), colors.Text(), 0.06)}
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
func toolBodyNodes(cx *core.Scope, run toolRun) []core.Node {
	colors := ui.ColorsOf(cx)
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
				Style:     core.Style{FontFamily: ui.Mono, FontSize: 11.5, LineHeight: 17, Background: bg, Width: core.Pct(100)},
				StyleFunc: ui.Colored(func() core.Color { return ink })})
		}
		return lines
	}
	var nodes []core.Node
	for _, line := range run.Nested {
		nodes = append(nodes, core.Text{Content: "· " + line, Selectable: core.SelectableOn,
			Style: core.Style{FontFamily: ui.Mono, FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Faint)})
	}
	out := run.Output
	if out == "" {
		out = "（没有输出）"
	}
	nodes = append(nodes, core.Text{Content: out, Selectable: core.SelectableOn,
		Style: core.Style{FontFamily: ui.Mono, FontSize: 11.5, LineHeight: 17}, StyleFunc: ui.Colored(colors.Code)})
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

// markdownView renders prose. A streaming one repairs what the text leaves
// open and ends with a pulsing caret.
func markdownView(text string, streaming func() bool, caret bool) core.Node {
	return markdownSearchView(nil, text, streaming, caret)
}

// markdownSearchView is markdownView joined to a transcript search, which
// highlights its matches.
func markdownSearchView(search *textview.Search, text string, streaming func() bool, caret bool) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		styles := ui.TextViewStyles(cx)
		styles[textview.PartRoot] = styles[textview.PartRoot].Merge(core.Style{Gap: 10, FontSize: 13.5, LineHeight: 22})
		colors := ui.ColorsOf(cx)
		styles[textview.PartSearch] = core.Style{Background: ui.Alpha(colors.Accent(), 0.18)}
		styles[textview.PartSearchSelected] = core.Style{Background: ui.Alpha(colors.Accent(), 0.45)}
		hl := highlight.New(cx)
		on := streaming()
		return ui.TextView{
			MarkdownFunc:         func() string { return text },
			Options:              textview.Options{Streaming: on},
			Styles:               styles,
			Search:               search,
			Selectable:           true,
			Highlighter:          hl,
			OpenLinks:            true,
			RenderMath:           formula.RenderMath,
			RenderDiagram:        diagram.RenderDiagram,
			NoCodeBlockScrollbar: true,
			CodeBlockActions:     []textview.CodeAction{{ID: textview.CopyAction, Label: T("复制")}},
		}
	})
}

// composer is the input card under the transcript. It reads nothing while
// building: the draft, the images and the run state are functions, so
// typing never rebuilds the field and never loses the caret.
func (a *app) composer(s *session) core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		return chat.Composer{
			Draft:         s.draft.Get,
			OnDraftChange: s.draft.Set,
			Label:         T("消息"),
			PlaceholderFunc: func() string {
				if s.busyNow() {
					return T("运行中：回车插入引导，或点停止")
				}
				if !s.readySig.Get() {
					return T("正在启动 pi…")
				}
				return T("给 pi 发消息…")
			},
			SendLabel: T("发送"),
			StopLabel: T("停止"),
			Running:   s.busy,
			OnSend:    a.send,
			OnStop:    func() { a.stop(s) },
			Suggest: func(query string) []chat.Suggestion {
				files := mentionMatches(a.workspaceFiles(s.WS), query, 8)
				rows := make([]chat.Suggestion, 0, len(files))
				for _, rel := range files {
					rows = append(rows, chat.Suggestion{
						SuggestItem: base.SuggestItem{ID: rel, Label: rel, Insert: "@" + rel + " "},
						Icon:        lucide.File,
					})
				}
				return rows
			},
			SuggestLabel: T("文件"),
			Glass:        true,
			State:        s.conversation,
			Accessory:    a.composerAccessory(s),
			Trailing:     a.composerTrailing(s),
			Footer:       a.composerFooter(s),
			Attachments:  a.attachments(s),
			HasAttachments: func() bool {
				return len(s.images.Get()) > 0
			},
			OnDropFiles: func(uris []string) { a.dropFiles(s, uris) },
			OnPaste: func(e core.PasteEvent) {
				for _, f := range e.Files {
					if strings.HasPrefix(f.MIME, "image/") && len(f.Data) > 0 {
						a.addImage(s, promptImage{Data: f.Data, MimeType: f.MIME, Name: f.Name})
					}
				}
				for _, uri := range e.URIs {
					a.dropFiles(s, []string{uri})
				}
			},
		}
	})
}

// composerAccessory is the model and thinking controls.
func (a *app) composerAccessory(s *session) chat.View {
	return func(cx *core.Scope) core.Node {
		plan := hintOf(func() string { return T("计划模式") }, ui.IconButton{Icon: lucide.ClipboardList, Label: T("计划模式"), Size: 26, IconSize: 13, TestID: "plan-mode",
			Selected: s.planMode.Get, OnPress: func() { a.togglePlanMode(s) }})
		persona := a.personaChip(s)
		aiTool := func(tool string, icon func() *core.SVG, label, testID string, press func()) core.Node {
			return core.Dynamic(func(cx *core.Scope) core.Node {
				if a.aiBusy.Get() == tool {
					return ui.Spinner{Size: 11}
				}
				return hintOf(func() string { return T(label) }, ui.IconButton{Icon: icon, Label: T(label), Size: 26, IconSize: 13,
					TestID: testID, Disabled: func() bool {
						return a.aiBusy.Get() != "" || strings.TrimSpace(s.draft.Get()) == ""
					}, OnPress: press})
			})
		}
		ai := core.Group{
			aiTool("prompt", lucide.WandSparkles, "增强提示词", "prompt-enhance", func() { a.enhanceDraft(s) }),
			aiTool("predict", lucide.Sparkles, "续写", "prompt-predict", func() { a.predictDraft(s) }),
		}
		if s.backend == "acp" {
			return core.Group{persona, plan, a.acpBadge(s), a.acpCommandMenu(s), ai}
		}
		return core.Group{persona, plan, a.modelMenu(s, s.modelOpen), a.effortPicker(s), ai}
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

// effortPicker chooses the reasoning level with the chat kit's slider: the
// levels the current model accepts, dragged or pressed. It is rebuilt when
// the model changes, because each model has its own levels.
func (a *app) effortPicker(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		levels := s.levels.Get()
		if len(levels) == 0 {
			return nil
		}
		var options []chat.Option
		for _, l := range levels {
			options = append(options, chat.Option{ID: l, Label: levelLabel(l)})
		}
		return chat.EffortPicker{
			Label:  T("思考"),
			Icon:   lucide.Brain,
			Levels: options,
			Selected: func() string {
				return s.thinking.Get()
			},
			OnChange: func(id string) { a.applyThinking(s, id, true) },
			Off:      true,
			Tooltip: func() string {
				if len(levels) == 1 {
					return "思考等级 · " + levelLabel(s.thinking.Get()) + "（该模型只有这一档）"
				}
				return "思考等级 · " + levelLabel(s.thinking.Get())
			},
			TestID: "effort-picker",
		}
	})
}

// composerTrailing is the attach button and context gauge, and the mark
// that says pi answered for this session.
func (a *app) composerTrailing(s *session) chat.View {
	return func(cx *core.Scope) core.Node {
		return core.Group{
			chat.IconAction{Label: T("粘贴图片"), Icon: lucide.ImagePlus, OnPress: func() { a.pasteImage(s) }},
			chat.ContextMeter{
				Label: T("上下文"), Title: T("上下文用量"),
				Tooltip:  func() string { return "上下文 · " + a.contextValue(s) },
				Value:    func() string { return a.contextValue(s) },
				Fraction: func() float64 { return a.contextFraction(s) },
				TestID:   "context-meter",
			},
		}
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

// composerFooter is the row of chips under the input: the project the
// session runs in, what is queued or failing, and the usage panel.
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
			a.projectMenu(s, s.projectOpen),
			core.Show{When: func() bool { return s.queued.Get() > 0 }, Then: func(cx *core.Scope) core.Node {
				return chat.Chip{TextFunc: func() string { return fmt.Sprintf("排队 %d", s.queued.Get()) }, Icon: lucide.ListOrdered}
			}},
			core.Show{When: func() bool { return s.notice.Get() != "" }, Then: func(cx *core.Scope) core.Node {
				return core.Text{ContentFunc: func() string { return shorten(s.notice.Get(), 40) }, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FlexShrink: 1, FontFamily: ui.Mono, FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)}
			}},
			core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}},
			a.usageMenu(s, s.usageOpen),
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
		Children: []core.Node{core.View{Style: core.Style{FlexGrow: 1, Width: core.Pct(100), MaxWidth: core.Pt(720), MinHeight: core.Pt(0),
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
								Style: core.Style{FontFamily: ui.Mono, FontSize: 10, TextAlign: core.TextAlignCenter}, StyleFunc: ui.Colored(colors.Faint)},
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
					core.Text{Content: "PiDeck Lite", Style: core.Style{FontFamily: ui.Mono, FontSize: 22, FontWeight: ui.Bold, LetterSpacing: 0.4},
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
						ui.Button{Text: T("导入会话"), Variant: ui.ButtonSecondary, TestID: "welcome-secondary", OnPress: func() { a.openPicker("import") }},
					}},
					core.Text{Content: T("NSGo 原生窗口 · 不是 Electron · 会话由本机 pi 的 RPC 模式驱动"),
						Style: core.Style{FontFamily: ui.Mono, FontSize: 10, TextAlign: core.TextAlignCenter, LineHeight: 16}, StyleFunc: ui.Colored(colors.Faint)},
				}},
			}}
	})
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

// todoBar is the agent's task list above the composer: a progress line
// that opens to the items. It stays out of the way when there is no list.
func (a *app) todoBar(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		items := s.todos.Get()
		if len(items) == 0 {
			return nil
		}
		done, total := todoCounts(items)
		open := s.todoOpen.Get()
		current := ""
		for _, it := range items {
			if it.Status == "in_progress" {
				current = it.Text
				break
			}
		}
		if current == "" && done < total {
			for _, it := range items {
				if it.Status == "pending" {
					current = it.Text
					break
				}
			}
		}
		head := core.View{
			OnPress: func(core.PressEvent) { s.todoOpen.Update(func(v bool) bool { return !v }) },
			Role:    core.RoleButton, Label: T("任务列表"), TestID: "todo-bar",
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(32),
					Padding: core.Symmetric(0, 10), CornerRadius: 8, BorderWidth: 1, BorderColor: colors.Border(),
					Background: colors.Surface(), Hover: &core.Style{Background: colors.Hover()},
					Transition: pressMotion}
			},
			Children: []core.Node{
				ui.Icon(lucide.ListChecks, 13, colors.Muted),
				core.Text{ContentFunc: func() string {
					d, t := todoCounts(s.todos.Get())
					return fmt.Sprintf("任务 %d/%d", d, t)
				}, Style: core.Style{FontSize: 11.5}, StyleFunc: ui.Colored(colors.Text)},
				core.View{Style: core.Style{Width: core.Pt(84), Height: core.Pt(4), CornerRadius: 2, Background: colors.Track()}, Children: []core.Node{
					core.View{StyleFunc: func() core.Style {
						d, t := todoCounts(s.todos.Get())
						p := float32(0)
						if t > 0 {
							p = float32(d) / float32(t)
						}
						return core.Style{Width: core.Pct(p * 100), Height: core.Pt(4), CornerRadius: 2, Background: colors.Up()}
					}},
				}},
				core.Text{ContentFunc: func() string {
					if current == "" {
						return "全部完成"
					}
					return shorten(current, 54)
				}, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
				ui.IconOf(func() *core.SVG {
					if open {
						return lucide.ChevronDown()
					}
					return lucide.ChevronUp()
				}, 12, colors.Faint),
				core.View{OnPress: func(core.PressEvent) { s.todos.Set(nil) }, Role: core.RoleButton, Label: T("清除任务列表"),
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
			core.View{Style: core.Style{Direction: core.Column, Gap: 1, MaxHeight: core.Pt(168)},
				Children: []core.Node{core.Scroll{Style: core.Style{MaxHeight: core.Pt(168)}, Children: []core.Node{
					core.View{Style: core.Style{Direction: core.Column, Gap: 1}, Children: rows},
				}}}},
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
