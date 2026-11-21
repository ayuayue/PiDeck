//go:build !js && !android && !ios

package workbench

// The chat: turns with their tools, the composer, and the empty state.

import (
	"strings"
	"time"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// turnView is one prompt and everything pi answered.
func (a *app) turnView(s *session, t func() turn, index func() int) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		// The clock is read inside the labels that show an elapsed time,
		// never here: rebuilding the turn every second would reset the
		// disclosures inside it.
		now := func() time.Time { return a.clock.Get() }
		response := chat.Turn{
			Status: func() chat.Status { return t().Status },
			// The fold row says what the process did; the duration sits at
			// the end of the turn instead, so it is not read twice.
			Summary: func() string {
				tt := t()
				var parts []string
				if tt.Plan {
					parts = append(parts, apptext.T("计划"))
				}
				if tt.Goal {
					parts = append(parts, apptext.T("目标"))
				}
				if tt.Tools > 0 {
					parts = append(parts, apptext.T("%d 个工具调用", tt.Tools))
				}
				switch tt.Status {
				case chat.Cancelled:
					parts = append(parts, apptext.T("已停止"))
				case chat.Failed:
					parts = append(parts, apptext.T("出错"))
				}
				if len(parts) == 0 {
					parts = append(parts, apptext.T("过程"))
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
			Steps: func() []chat.Step { return a.steps(s, t()) },
			Final: func(cx *core.Scope) core.Node {
				tt := t()
				return core.View{Style: core.Style{MinWidth: core.Pt(0)}, Children: []core.Node{a.chatMarkdown(tt.Final, false, a.readingFont(), a.readingLine(), core.Style{})}}
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
								core.Text{ContentFunc: func() string { return apptext.T("已停止 · 用时 %s", duration(t().elapsed(now()))) },
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
						chat.IconAction{Label: apptext.T("执行计划"), Icon: lucide.Play,
							Disabled: func() bool { return t().running() || t().Final == "" },
							OnPress:  func() { a.executePlan(s, tt) }},
						chat.IconAction{Label: apptext.T("逐步执行"), Icon: lucide.ListChecks,
							Disabled: func() bool { return t().running() || len(planSteps(t().Final)) < 2 },
							OnPress:  func() { a.executePlanSteps(s, tt) }},
						chat.IconAction{Label: apptext.T("修改计划"), Icon: lucide.PencilLine,
							Disabled: func() bool { return t().Final == "" },
							OnPress:  func() { a.editPlan(s, tt) }},
					)
				}
				actions := append(planActions, []core.Node{
					chat.IconAction{Label: apptext.T("重新发送"), Icon: lucide.RefreshCw,
						Disabled: func() bool { return (tt.Prompt == "" && len(tt.Images) == 0) || t().running() },
						OnPress:  func() { a.resendTurn(s, tt) }},
					chat.IconAction{Label: apptext.T("修改提问"), Icon: lucide.SquarePen, TestID: "turn-edit-prompt",
						Disabled: func() bool { return t().running() || tt.Prompt == "" }, OnPress: func() { a.editTurnPrompt(s, tt) }},
					chat.IconAction{Label: apptext.T("复制回复"), Icon: lucide.Copy, OnPress: func() {
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
					chat.IconAction{Label: apptext.T("翻译回复"), Icon: lucide.Languages, TestID: "turn-translate",
						Disabled: func() bool { return t().running() || tt.Final == "" }, OnPress: func() { a.openTranslationWith(tt.Final) }},
					chat.IconAction{Label: apptext.T("收藏这条回复"), Icon: lucide.Star, TestID: "turn-favorite",
						OnPress: func() { a.favoriteReply(s, t()) }},
					a.turnMoreActions(s, t),
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
		return core.View{Style: core.Style{MinWidth: core.Pt(0), Gap: 24},
			Children: []core.Node{a.turnPrompt(t), response}}
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
					LineHeight: a.readingDetailLine(), FontFamily: viewkit.MonoFont()}, StyleFunc: ui.Colored(colors.Faint)})
			}
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4,
				Padding: core.Edges{Left: 4}}, Children: row}
		},
	}
}
