//go:build !js && !android && !ios

package workbench

// The ask card above the composer: the request pi or an extension waits on,
// asked one question or many at a time. Selection answers on the click;
// typing answers with its button or Return; a batch moves through its
// questions, can skip any of them, and shows a review page when the
// extension asked for one.

import (
	"fmt"
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/remotewire"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// askCardStyle is the card's frame: a raised surface over the composer's
// place, with room for the question and its answers.
func askCardStyle(colors ui.Colors) core.Style {
	return core.Style{Direction: core.Column, Gap: 9, Padding: core.Symmetric(11, 12), CornerRadius: 13,
		BorderWidth: 1, BorderColor: colors.Border(), Background: colors.Surface(), MinWidth: core.Pt(0)}
}

// askFieldStyle is a text answer's field.
func askFieldStyle(colors ui.Colors) core.Style {
	return core.Style{MinHeight: core.Pt(32), Padding: core.Symmetric(7, 9), CornerRadius: 7, FontSize: 12.5,
		LineHeight: 18, Color: colors.Text(), Background: colors.Field(),
		BorderWidth: 1, BorderColor: colors.FieldBorder()}
}

// askPanel draws the request showing, in the composer's place: the card is
// where the user types, and the composer waits behind it.
func (a *app) askPanel(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		_ = a.askSeq.Get()
		_ = a.langRev.Get()
		ask := s.showingAsk()
		if ask == nil {
			return nil
		}
		colors := ui.ColorsOf(cx)
		state := s.askUI.Get()
		batch := ask.Method == remotewire.AskMethodBatch
		return core.View{TestID: "ask-card", StyleFunc: func() core.Style {
			return askCardStyle(colors)
		}, Children: []core.Node{
			a.askHead(s, ask, state, batch),
			a.askTabs(s, ask, state, batch),
			a.askBody(s, ask, state, batch),
			a.askFooter(s, ask, state, batch),
		}}
	})
}

// askHead is the card's first row: what this is, which question, and the
// way out.
func (a *app) askHead(s *session, ask *extensionAsk, state askUIState, batch bool) core.Node {
	colors := ui.ColorsOf(a.cx)
	head := []core.Node{
		ui.Icon(lucide.BadgeQuestionMark, 13, colors.Accent),
		ui.Text(apptext.T("提问"), 11.5, ui.Semibold, colors.Text),
	}
	if batch {
		settled := askAnswered(ask, state)
		head = append(head,
			core.Text{ContentFunc: func() string {
				return apptext.T("%d/%d 题已答", settled, len(ask.Questions))
			}, Style: core.Style{FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)})
		if len(s.asks) > 0 {
			head = append(head, core.View{Style: core.Style{Padding: core.Symmetric(1, 5), CornerRadius: 5, Background: colors.Inset()},
				Children: []core.Node{ui.Textf(func() string { return apptext.T("还有 %d 个", len(s.asks)) }, 9.5, ui.Regular, colors.Faint)}})
		}
	}
	head = append(head, core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}})
	head = append(head, hintOf(func() string { return apptext.T("关闭") }, ui.IconButton{Icon: lucide.X, Label: apptext.T("关闭"), Size: 22,
		IconSize: 11.5, TestID: "ask-card-close", OnPress: func() { a.closeAsk(s, ask) }}))
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinWidth: core.Pt(0)},
		Children: head}
}

// askTabs is the batch's question strip: which one shows, and which are
// answered or skipped.
func (a *app) askTabs(s *session, ask *extensionAsk, state askUIState, batch bool) core.Node {
	if !batch || (len(ask.Questions) <= 1 && !ask.Review) {
		return nil
	}
	colors := ui.ColorsOf(a.cx)
	tab := func(index int, label string) core.Node {
		on := state.Tab == index
		answered := false
		skipped := false
		if index < len(ask.Questions) {
			ans := state.Answers[ask.Questions[index].ID]
			answered = ans.answered() && !ans.Skipped
			skipped = ans.Skipped
		}
		return core.View{OnPress: func(core.PressEvent) { a.setAskTab(s, index) },
			Role: core.RoleTab, Label: label, TestID: fmt.Sprintf("ask-tab-%d", index+1),
			StyleFunc: func() core.Style {
				st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, Height: core.Pt(24),
					Padding: core.Symmetric(0, 8), CornerRadius: 6, Transition: viewkit.PressMotion,
					Hover: &core.Style{Background: colors.Hover()}}
				switch {
				case on:
					st.Background = colors.Pressed()
				case skipped:
					st.Opacity = core.Alpha(0.55)
				}
				return st
			}, Children: []core.Node{
				core.Text{Content: label, Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Text)},
				func() core.Node {
					if skipped {
						return ui.Icon(lucide.SkipForward, 9.5, colors.Faint)
					}
					if answered {
						return ui.Icon(lucide.Check, 9.5, colors.Up)
					}
					return nil
				}(),
			}}
	}
	tabs := make([]core.Node, 0, len(ask.Questions)+1)
	for i := range ask.Questions {
		tabs = append(tabs, tab(i, fmt.Sprint(i+1)))
	}
	if ask.Review {
		tabs = append(tabs, tab(len(ask.Questions), apptext.T("提交审阅")))
	}
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Wrap: core.Wrap, Gap: 2},
		Children: tabs}
}

// askBody is what the card asks: the question and the control its type
// answers with, or the review page.
func (a *app) askBody(s *session, ask *extensionAsk, state askUIState, batch bool) core.Node {
	colors := ui.ColorsOf(a.cx)
	if batch && state.Review && state.Tab == len(ask.Questions) {
		return a.askReview(s, ask, state)
	}
	if batch {
		q := askQuestionAt(ask, state.Tab)
		if q == nil {
			return nil
		}
		return core.View{Style: core.Style{Gap: 7, MinWidth: core.Pt(0)}, Children: []core.Node{
			core.Text{Content: q.Question, Style: core.Style{FontSize: 13, LineHeight: 19}, StyleFunc: ui.Colored(colors.Text)},
			a.askQuestionBody(s, ask, *q, state),
		}}
	}
	title := ask.Title
	if title == "" {
		title = apptext.T("扩展请求确认")
	}
	var body []core.Node
	body = append(body, core.Text{Content: title, Style: core.Style{FontSize: 13, LineHeight: 19},
		StyleFunc: ui.Colored(colors.Text)})
	if msg := strings.TrimSpace(ask.Message); msg != "" && msg != title {
		body = append(body, core.Text{Content: msg, MaxLines: 4, EllipsizeMode: core.EllipsizeTail,
			Style: core.Style{FontSize: 11.5, LineHeight: 17}, StyleFunc: ui.Colored(colors.Muted)})
	}
	q := askQuestion{ID: ask.ID, Type: ask.Method, Question: title, Options: ask.Choices,
		AllowOther: ask.AllowOther, Placeholder: ask.Placeholder, Prefill: ask.Default}
	body = append(body, a.askQuestionBody(s, ask, q, state))
	return core.View{Style: core.Style{Gap: 7, MinWidth: core.Pt(0)}, Children: body}
}

// askQuestionBody is one question's control by its type.
func (a *app) askQuestionBody(s *session, ask *extensionAsk, q askQuestion, state askUIState) core.Node {
	switch q.Type {
	case askSelect:
		return a.askSelectBody(s, ask, q, state)
	case askMultiSelect:
		return a.askMultiBody(s, ask, q, state)
	case askConfirm:
		yes := func() { a.answerConfirm(s, ask, true) }
		no := func() { a.answerConfirm(s, ask, false) }
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
			ui.Button{Text: apptext.T("是"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "ask-confirm-yes", OnPress: yes},
			ui.Button{Text: apptext.T("否"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "ask-confirm-no", OnPress: no},
		}}
	case askEditor:
		return a.askTextField(s, ask, q, state, true)
	default:
		return a.askTextField(s, ask, q, state, false)
	}
}

// askSelectBody is a single choice: full-width options and the row for an
// answer of the user's own.
func (a *app) askSelectBody(s *session, ask *extensionAsk, q askQuestion, state askUIState) core.Node {
	colors := ui.ColorsOf(a.cx)
	var rows []core.Node
	for _, opt := range q.Options {
		o := opt
		rows = append(rows, a.askOptionRow(s, ask, func() { a.chooseAskOption(s, ask, o) }, o, false, "ask-option-"+o.Value))
	}
	body := []core.Node{core.View{Style: core.Style{Gap: 3}, Children: rows}}
	if q.AllowOther {
		submit := func() { a.submitAskField(s, ask) }
		body = append(body, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
			core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
				core.Input{Value: func() string { return askText(s, q.ID) }, OnChange: func(t string) { a.setAskText(s, q.ID, t) },
					OnSubmit: func(string) { submit() }, Placeholder: apptext.T("或输入自定义内容…"),
					Label: apptext.T("自定义回答"), TestID: "ask-custom", Style: askFieldStyle(colors)},
			}},
			ui.Button{Text: apptext.T("提交"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "ask-custom-submit",
				OnPress: submit, Disabled: func() bool { return strings.TrimSpace(askText(s, q.ID)) == "" }},
		}})
	}
	return core.View{Style: core.Style{Gap: 7, MinWidth: core.Pt(0)}, Children: []core.Node{
		core.Scroll{Style: core.Style{MaxHeight: core.Pt(260)}, Children: []core.Node{core.View{Style: core.Style{Gap: 3}, Children: body}}},
	}}
}

// askMultiBody is the multiple choice: toggles, then the way on.
func (a *app) askMultiBody(s *session, ask *extensionAsk, q askQuestion, state askUIState) core.Node {
	chosen := map[string]bool{}
	if list, ok := state.Answers[q.ID].Value.([]string); ok {
		for _, v := range list {
			chosen[v] = true
		}
	}
	var rows []core.Node
	for _, opt := range q.Options {
		o := opt
		rows = append(rows, a.askOptionRow(s, ask, func() { a.toggleMultiSelect(s, ask, q, o) }, o, chosen[o.Value], "ask-multi-"+o.Value))
	}
	return core.View{Style: core.Style{Gap: 5}, Children: []core.Node{
		core.Scroll{Style: core.Style{MaxHeight: core.Pt(240)}, Children: []core.Node{core.View{Style: core.Style{Gap: 3}, Children: rows}}},
		ui.Text(apptext.T("可多选"), 9.5, ui.Regular, ui.ColorsOf(a.cx).Faint),
	}}
}

// askOptionRow is one choice: a full-width row with its line of
// description, marked when it is chosen.
func (a *app) askOptionRow(s *session, ask *extensionAsk, on func(), opt askOption, chosen bool, testID string) core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{OnPress: func(core.PressEvent) { on() }, Role: core.RoleButton, Label: opt.Label, TestID: testID,
		StyleFunc: func() core.Style {
			st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(32),
				Padding: core.Symmetric(5, 9), CornerRadius: 7, BorderWidth: 1, BorderColor: colors.Line(),
				Background: colors.Surface(), Transition: viewkit.PressMotion, Hover: &core.Style{Background: colors.Hover()},
				Active: &core.Style{Background: colors.Pressed()}}
			if chosen {
				st.BorderColor = colors.Accent()
				st.Background = ui.Alpha(colors.Accent(), 0.10)
			}
			return st
		}, Children: []core.Node{
			func() core.Node {
				if chosen {
					return ui.Icon(lucide.Check, 11, colors.Accent)
				}
				return core.View{Style: core.Style{Width: core.Pt(11), Height: core.Pt(11)}}
			}(),
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
				core.Text{Content: opt.Label, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
				func() core.Node {
					desc := strings.TrimSpace(opt.Description)
					if desc == "" {
						return nil
					}
					return core.Text{Content: desc, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Muted)}
				}(),
			}},
		}}
}

// askTextField is an input or editor answer: the field, then its submit.
func (a *app) askTextField(s *session, ask *extensionAsk, q askQuestion, state askUIState, multiline bool) core.Node {
	colors := ui.ColorsOf(a.cx)
	placeholder := q.Placeholder
	if placeholder == "" {
		if multiline {
			placeholder = apptext.T("编辑内容…")
		} else {
			placeholder = apptext.T("输入回答…")
		}
	}
	submit := func() { a.submitAskField(s, ask) }
	field := core.Input{Value: func() string { return askText(s, q.ID) },
		OnChange: func(t string) { a.setAskText(s, q.ID, t) }, Multiline: multiline, AutoFocus: true,
		Placeholder: placeholder, Label: apptext.T("回答"), TestID: "ask-text", Style: askFieldStyle(colors)}
	field.OnSubmit = func(string) {
		if !multiline {
			submit()
		}
	}
	if multiline {
		field.Style.MinHeight = core.Pt(92)
	}
	return core.View{Style: core.Style{Gap: 6, MinWidth: core.Pt(0)}, Children: []core.Node{
		field,
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
			core.Text{ContentFunc: func() string {
				if q.Type == askEditor {
					return apptext.T("Ctrl+Enter 也可以提交")
				}
				return apptext.T("回车提交")
			}, Style: core.Style{FontSize: 9.5, FlexGrow: 1}, StyleFunc: ui.Colored(colors.Faint)},
			ui.Button{Text: apptext.T("提交"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "ask-text-submit",
				OnPress: submit, Disabled: func() bool { return strings.TrimSpace(askText(s, q.ID)) == "" }},
		}},
	}}
}

// askReview is the answered sheet, when the extension asked for one.
func (a *app) askReview(s *session, ask *extensionAsk, state askUIState) core.Node {
	colors := ui.ColorsOf(a.cx)
	var rows []core.Node
	for i, q := range ask.Questions {
		index := i
		ans := state.Answers[q.ID]
		value := "-"
		tint := colors.Faint
		switch {
		case ans.Skipped:
			value = apptext.T("已跳过")
		case ans.answered():
			value = ans.Label
			if strings.TrimSpace(value) == "" {
				value = fmt.Sprint(ans.Value)
			}
			tint = colors.Text
		}
		rows = append(rows, core.View{OnPress: func(core.PressEvent) { a.setAskTab(s, index) },
			Role: core.RoleButton, Label: q.Question, TestID: fmt.Sprintf("ask-review-%d", i+1),
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(28),
					Padding: core.Symmetric(3, 6), CornerRadius: 6, Hover: &core.Style{Background: colors.Hover()}}
			}, Children: []core.Node{
				ui.Text(fmt.Sprint(i+1), 10, ui.Medium, colors.Faint),
				core.Text{Content: q.Question, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11.5}, StyleFunc: ui.Colored(colors.Muted)},
				core.Text{Content: viewkit.FirstLine(value, 40), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(tint)},
			}})
	}
	body := []core.Node{core.Scroll{Style: core.Style{MaxHeight: core.Pt(220)}, Children: []core.Node{
		core.View{Style: core.Style{Gap: 1}, Children: rows}}}}
	if !askSettled(ask, state) {
		body = append(body, core.Text{Content: apptext.T("还有题目未回答"), Style: core.Style{FontSize: 10.5},
			StyleFunc: ui.Colored(colors.Warn)})
	}
	return core.View{Style: core.Style{Gap: 7}, Children: body}
}

// askFooter is the batch's way through: where the user is, back, skip, on,
// or submit.
func (a *app) askFooter(s *session, ask *extensionAsk, state askUIState, batch bool) core.Node {
	if !batch {
		return nil
	}
	colors := ui.ColorsOf(a.cx)
	last := len(ask.Questions) - 1
	tab := state.Tab
	review := state.Review && tab >= len(ask.Questions)
	q := askQuestionAt(ask, tab)
	settled := q != nil && state.Answers[q.ID].answered()
	done := askAnswered(ask, state)
	var right []core.Node
	if tab > 0 {
		right = append(right, ui.Button{Text: apptext.T("上一题"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
			TestID: "ask-prev", OnPress: func() { a.setAskTab(s, tab-1) }})
	}
	right = append(right, ui.Button{Text: apptext.T("跳过此题"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
		TestID: "ask-skip", OnPress: func() { a.skipAsk(s, ask) }})
	switch {
	case review:
		right = append(right, ui.Button{Text: apptext.T("提交"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall,
			TestID: "ask-submit", Disabled: func() bool { return !askSettled(ask, state) },
			OnPress: func() { a.submitBatch(s, ask, false) }})
	case tab < last:
		right = append(right, ui.Button{Text: apptext.T("下一题"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
			TestID: "ask-next", Disabled: func() bool { return !settled },
			OnPress: func() { a.setAskTab(s, tab+1) }})
	default:
		right = append(right, ui.Button{Text: apptext.T("提交"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall,
			TestID: "ask-submit", Disabled: func() bool { return !settled },
			OnPress: func() { a.advanceAsk(s, ask) }})
	}
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6,
		Borders: core.Edges{Top: 1}, BorderColors: core.EdgeColors{Top: colors.Line()}, Padding: core.Edges{Top: 8}},
		Children: []core.Node{
			core.Text{ContentFunc: func() string { return apptext.T("已完成 %d/%d", done, len(ask.Questions)) },
				Style: core.Style{FontSize: 10, FlexGrow: 1}, StyleFunc: ui.Colored(colors.Faint)},
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4}, Children: right},
		}}
}
