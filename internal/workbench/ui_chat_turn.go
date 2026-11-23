//go:build !js && !android && !ios

package workbench

// The chat: turns with their tools, the composer, and the empty state.

import (
	"slices"
	"strings"
	"time"

	"example.com/pideck-v2/assets"
	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"example.com/pideck-v2/internal/viewkit/brands"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// turnView is one prompt and everything pi answered.
//
// It is built once for its turn and keyed by the turn's stable ID, so what
// changes while pi works — the streamed prose, a finished tool call, a
// resolved fold — repaints the part that shows it instead of rebuilding the
// row. A turn is folded once it has an answer: the process goes behind one
// centered summary row, and inside it every process group folds on its own.
func (a *app) turnView(s *session, t func() turn, index func() int) core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		// The clock is read inside the labels that show an elapsed time,
		// never here: rebuilding the turn every second would reset the
		// disclosures inside it.
		now := func() time.Time { return a.clock.Get() }
		foldKey := s.ID + "/fold/" + t().ID
		auto := func() bool { return t().running() }
		open := func() bool {
			s.uiSeq.Get() // redraw when the user folds or unfolds
			return s.foldOpen(foldKey, auto())
		}
		toggle := func() { s.toggleFold(foldKey, auto()) }
		process := func() bool { tt := t(); return len(tt.Steps) > 0 || tt.running() }
		// A turn folds only once its answer arrived: a running one, or one
		// whose answer is the last successful message, keeps its process in
		// sight.
		foldable := func() bool { tt := t(); return len(tt.Steps) > 0 && !tt.running() && tt.Final != "" }
		showProcess := func() bool { return open() || (process() && !foldable()) }
		return core.View{Style: core.Style{MinWidth: core.Pt(0), FlexShrink: 0, Gap: 24}, Children: []core.Node{
			a.turnPrompt(s, t),
			core.View{Style: core.Style{MinWidth: core.Pt(0), FlexShrink: 0, Gap: 16}, Children: []core.Node{
				core.Show{When: func() bool {
					tt := t()
					return !tt.System && (tt.Final != "" || tt.running() || tt.Err != "")
				}, Then: func(*core.Scope) core.Node { return a.turnReplyHeader(s, t) }},
				core.Show{When: foldable, Then: func(cx *core.Scope) core.Node { return a.turnFoldRow(cx, t, open, toggle) }},
				core.Show{When: showProcess, Then: func(cx *core.Scope) core.Node { return a.turnProcess(s, t) }},
				core.Show{When: func() bool { return t().running() }, Then: func(cx *core.Scope) core.Node {
					return a.turnWorkingRow(cx, t, now)
				}},
				core.Show{When: func() bool { tt := t(); return !tt.running() && tt.Final != "" }, Then: func(cx *core.Scope) core.Node {
					return a.replyContent(s, t, a.chatMarkdownLive(func() string { return t().Final }, func() bool { return false }, core.Style{}))
				}},
				a.turnFooter(s, t, now),
				core.Show{When: func() bool { tt := t(); return !tt.running() && (tt.Final != "" || tt.Err != "") },
					Then: func(cx *core.Scope) core.Node {
						return core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 4},
							Children: []core.Node{a.turnActions(s, t, now)}}
					}},
			}},
		}}
	})
}

// turnReplyHeader says who answered and when, above the answer itself: pi,
// with the app's own mark, or the ACP preset that replied.
func (a *app) turnReplyHeader(s *session, t func() turn) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		tt := t()
		name, mark := a.replyAuthor(cx, s, tt)
		children := []core.Node{mark, core.Text{Content: name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
			Style: core.Style{FontSize: 12.5, FontWeight: ui.Medium, MinWidth: core.Pt(0), FlexShrink: 1}, StyleFunc: ui.Colored(colors.Muted)}}
		if stamp := clockTime(tt.End); stamp != "" {
			children = append(children,
				core.Text{Content: "·", Style: core.Style{FontSize: 12.5}, StyleFunc: ui.Colored(colors.Faint)},
				ui.Tabular(core.Text{Content: stamp, Style: core.Style{FontSize: 12.5, LineHeight: 18}, StyleFunc: ui.Colored(colors.Faint)}))
		}
		return core.View{TestID: "chat-reply-header", Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinWidth: core.Pt(0)},
			Children: children}
	})
}

// replyAuthor is who answered a turn, and the mark that stands for them.
func (a *app) replyAuthor(cx *core.Scope, s *session, t turn) (string, core.Node) {
	colors := ui.ColorsOf(cx)
	if backendOf(s) == "acp" {
		name := "ACP"
		if preset := a.acpPresetByID(s.acpPreset); preset != nil && preset.Name != "" {
			name = preset.Name
		}
		// The agent's own mark says which CLI replied; one the set does not
		// know keeps a terminal glyph and its name.
		if mark := brands.Mark(s.acpPreset, 14, func() core.Color { return colors.Muted() }); mark != nil {
			return name, mark
		}
		return name, ui.Icon(lucide.Terminal, 13, colors.Muted)
	}
	_ = t
	return "pi", core.Image{Source: core.ImageSource{Data: assets.LogoPNG}, Label: "pi",
		Style: core.Style{Width: core.Pt(16), Height: core.Pt(16), CornerRadius: 4}}
}

// turnFoldRow is the divider-centered summary of a completed turn: what the
// process did, and the disclosure that shows it.
func (a *app) turnFoldRow(cx *core.Scope, t func() turn, open func() bool, toggle func()) core.Node {
	colors := ui.ColorsOf(cx)
	divider := func() core.Node {
		return core.View{Style: core.Style{FlexGrow: 1, Height: core.Pt(1)}, StyleFunc: ui.Filled(colors.Border)}
	}
	label := func() string {
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
	}
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Height: core.Pt(24), Gap: 10}, Children: []core.Node{
		divider(),
		base.Button{Expanded: open, OnPress: func(core.PressEvent) { toggle() }, LabelFunc: label, TestID: "turn-fold",
			Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Height: core.Pt(24), Padding: core.Symmetric(0, 2), Gap: 5,
				CornerRadius: ui.RadiusControl},
			StyleFunc: func() core.Style { return core.Style{FocusVisible: ui.FocusRing(cx, 2)} },
			Children: []core.Node{
				ui.Textf(label, 13.5, ui.Medium, colors.Muted),
				ui.IconOf(disclosure(open), 11.5, colors.Muted),
			}},
		divider(),
	}}
}

// disclosure is the chevron of something open or closed.
func disclosure(open func() bool) func() *core.SVG {
	return func() *core.SVG {
		if open() {
			return lucide.ChevronDown()
		}
		return lucide.ChevronRight()
	}
}

// turnWorkingRow is the live line under a running turn: three dots a wave
// crosses, the note pi is carrying, and how long it has been.
func (a *app) turnWorkingRow(cx *core.Scope, t func() turn, now func() time.Time) core.Node {
	colors := ui.ColorsOf(cx)
	label := func() string {
		tt := t()
		name := apptext.T("正在工作")
		if tt.Noticed != "" {
			name = tt.Noticed
		}
		return name + " · " + duration(tt.elapsed(now()))
	}
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Height: core.Pt(22), Gap: 8}, Children: []core.Node{
		ui.Spinner{Size: 11},
		core.Text{ContentFunc: label, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
			Style: core.Style{FontSize: 13, FontWeight: ui.Medium, FlexShrink: 1, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Muted)},
	}}
}

// turnFooter holds what followed the answer: the changes it made, a
// failure, a stop, and pi's live note.
func (a *app) turnFooter(s *session, t func() turn, now func() time.Time) core.Node {
	return core.Group{
		a.changeSummary(s, t),
		core.Show{When: func() bool { tt := t(); return tt.Err != "" || tt.Status == chat.Failed }, Then: func(*core.Scope) core.Node {
			// The row's text and its button follow the turn and the turns
			// after it, so a retry leaves with the failure it belonged to.
			return core.Dynamic(func(*core.Scope) core.Node {
				tt := t()
				return a.errorRow(failureText(tt), a.retryAction(s, tt))
			})
		}},
		core.Show{When: func() bool { return t().Status == chat.Cancelled }, Then: func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7}, Children: []core.Node{
				ui.Icon(lucide.Square, 11, colors.Faint),
				core.Text{ContentFunc: func() string { return apptext.T("已停止 · 用时 %s", duration(t().elapsed(now()))) },
					Style: core.Style{FontSize: 12}, StyleFunc: ui.Colored(colors.Muted)},
			}}
		}},
		core.Show{When: func() bool { tt := t(); return !tt.running() && tt.Noticed != "" }, Then: func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				ui.Icon(lucide.Info, 11, colors.Muted),
				core.Text{ContentFunc: func() string { return t().Noticed },
					Style: core.Style{FontSize: 11.5}, StyleFunc: ui.Colored(colors.Muted)},
			}}
		}},
	}
}

// failureText is what a failed turn says: pi's own words when it gave any,
// and otherwise the app's, which promise a retry only while one is offered.
func failureText(t turn) string {
	if t.Err != "" {
		return t.Err
	}
	if t.Final == "" && t.Status == chat.Failed {
		return apptext.T("这一轮没有完成，可以重试。")
	}
	return apptext.T("这一轮没有完成。")
}

// retryAction is the retry a failure still deserves, nil once the turn or a
// later one answered: the session works again then, and the row keeps only
// pi's error text.
func (a *app) retryAction(s *session, t turn) func() {
	if s == nil || t.Final != "" || recoveredAfter(s.turns.Get(), t.ID) {
		return nil
	}
	return func() { a.retry(s, t) }
}

// recoveredAfter reports whether a later turn of the same session answered.
func recoveredAfter(turns []turn, id string) bool {
	at := slices.IndexFunc(turns, func(t turn) bool { return t.ID == id })
	if at < 0 {
		return false
	}
	for _, later := range turns[at+1:] {
		if later.Status == chat.Completed && later.Final != "" {
			return true
		}
	}
	return false
}

// replyContent offers the actions for this answer at the text itself.
func (a *app) replyContent(s *session, t func() turn, content core.Node) core.Node {
	return base.ContextMenu{
		Trigger: core.View{TestID: "chat-reply", Style: core.Style{MinWidth: core.Pt(0)}, Children: []core.Node{content}},
		TestID:  "chat-reply-menu", PopupStyleFunc: func() core.Style { return a.menuCard(a.cx) },
		PopupStyle: a.menuPopup(a.cx),
		Children: []core.Node{
			a.menuRow(a.cx, lucide.Copy, "复制回复", "", false, func() { a.copyText(t().Final, "回复") }),
			a.menuRow(a.cx, lucide.Languages, "翻译回复", "", false, func() { a.openTranslationWith(t().Final) }),
			a.menuRow(a.cx, lucide.Star, "收藏这条回复", "", false, func() { a.favoriteReply(s, t()) }),
			a.menuRow(a.cx, lucide.Activity, "查看轨迹", "", false, func() { a.openTrajectory(s, t()) }),
		},
	}
}

// turnActions is the row under a finished answer: what the turn can do
// again, and the fresh actions of a plan.
func (a *app) turnActions(s *session, t func() turn, now func() time.Time) core.Node {
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
		chat.IconAction{Label: apptext.T("复制回复"), Icon: lucide.Copy, TestID: "turn-copy", OnPress: func() {
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
		chat.IconAction{Label: apptext.T("修改提问"), Icon: lucide.SquarePen, TestID: "turn-edit-prompt",
			Disabled: func() bool { return t().running() || t().Prompt == "" }, OnPress: func() { a.editTurnPrompt(s, t()) }},
		chat.IconAction{Label: apptext.T("删除这一轮"), Icon: lucide.Trash, TestID: "turn-delete",
			Disabled: func() bool { return !canDeleteTurn(s, t()) }, OnPress: func() { a.askDeleteTurn(s, t()) }},
		chat.IconAction{Label: apptext.T("收藏这条回复"), Icon: lucide.Star, TestID: "turn-favorite",
			OnPress: func() { a.favoriteReply(s, t()) }},
		chat.IconAction{Label: apptext.T("重新生成"), Icon: lucide.RotateCcw, TestID: "turn-retry",
			Disabled: func() bool { tt := t(); return tt.running() || (tt.Prompt == "" && len(tt.Images) == 0) },
			OnPress:  func() { a.retry(s, t()) }},
		chat.IconAction{Label: apptext.T("从这里分叉"), Icon: lucide.GitBranch, TestID: "turn-fork",
			Disabled: func() bool { return !canBranchTurn(s, t()) }, OnPress: func() { a.forkSession(s, t().ID) }},
	}...)
	// The reply's own line closes the row: how long it took and which model
	// answered.
	return core.Group(append(actions, a.turnMeta(t, now)))
}

// promptActions sits under a sent prompt: copying it, editing it, deleting
// its turn, or forking from it.
func (a *app) promptActions(s *session, t func() turn) core.Node {
	return core.Show{
		When: func() bool { tt := t(); return !tt.running() && (tt.Prompt != "" || len(tt.Images) > 0) },
		Then: func(*core.Scope) core.Node {
			return core.View{TestID: "prompt-actions",
				Style: core.Style{Direction: core.Row, JustifyContent: core.JustifyEnd, Gap: 2, Padding: core.Edges{Right: 2}},
				Children: []core.Node{
					chat.IconAction{Label: apptext.T("复制提问"), Icon: lucide.Quote, TestID: "prompt-copy",
						OnPress: func() { a.copyText(t().Prompt, "提问") }},
					chat.IconAction{Label: apptext.T("修改提问"), Icon: lucide.SquarePen, TestID: "prompt-edit",
						Disabled: func() bool { return t().Prompt == "" }, OnPress: func() { a.editTurnPrompt(s, t()) }},
					chat.IconAction{Label: apptext.T("删除这一轮"), Icon: lucide.Trash, TestID: "prompt-delete",
						Disabled: func() bool { return !canDeleteTurn(s, t()) }, OnPress: func() { a.askDeleteTurn(s, t()) }},
					chat.IconAction{Label: apptext.T("从这里分叉"), Icon: lucide.GitBranch, TestID: "prompt-fork",
						Disabled: func() bool { return !canBranchTurn(s, t()) }, OnPress: func() { a.forkSession(s, t().ID) }},
				}}
		},
	}
}

// turnMeta ends a finished reply: how long the turn took, and the model
// that answered it. When it came back is said above the reply.
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
