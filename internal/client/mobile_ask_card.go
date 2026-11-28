package client

// The phone build: it connects to a desktop PiDeck server and browses
// its projects, sessions and transcripts. The same package builds the
// desktop; Root picks this screen on iOS and Android (or with
// PIDECK_V2_MOBILE=1 for a preview on a desktop).

import (
	"fmt"
	"strings"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/remotewire"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// askCard is the desktop's question card in the phone's size: a turn is
// waiting on it, so the phone answers it instead of leaving the turn at the
// desk. A batch of questions shows them all, each answered where it stands;
// one question keeps the short bar the phone always had.
func (a *mobileApp) askCard(cx *core.Scope) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		ask := a.ask.Get()
		if ask == nil {
			return nil
		}
		if ask.Method == remotewire.AskMethodBatch && len(ask.Questions) > 0 {
			return a.batchAskCard(cx, ask)
		}
		return a.simpleAskCard(cx, ask)
	})
}

// askCardStyle is the card's frame: the warning tint the phone uses for
// something that waits on the user.
func askCardStyle(colors ui.Colors) core.Style {
	return core.Style{Gap: 8, Padding: core.Symmetric(9, 12),
		Background:   ui.Alpha(colors.Warn(), 0.10),
		Borders:      core.Edges{Top: 1, Bottom: 1},
		BorderColors: core.EdgeColors{Top: ui.Alpha(colors.Warn(), 0.35), Bottom: ui.Alpha(colors.Warn(), 0.35)}}
}

// batchAskCard is several questions in one request: the count of settled
// ones, the questions, and the two ways out. What is typed lives in its own
// signals, read only where it changes something, so a keystroke never
// rebuilds the fields under the caret.
func (a *mobileApp) batchAskCard(cx *core.Scope, ask *remotewire.Ask) core.Node {
	colors := ui.ColorsOf(cx)
	sending := a.askSending.Get()
	rows := make([]core.Node, 0, len(ask.Questions))
	for i, q := range ask.Questions {
		rows = append(rows, a.askQuestionRow(cx, i, q, sending))
	}
	settled := func() int {
		n := 0
		for _, q := range ask.Questions {
			if a.askQuestionSettled(q) {
				n++
			}
		}
		return n
	}
	head := []core.Node{
		ui.Icon(lucide.BadgeQuestionMark, 14, colors.Warn),
		ui.Text(apptext.T("提问"), 12.5, ui.Semibold, colors.Text),
		core.Dynamic(func(cx *core.Scope) core.Node {
			return core.Text{Content: apptext.T("%d/%d 题已答", settled(), len(ask.Questions)),
				Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11},
				StyleFunc: ui.Colored(ui.ColorsOf(cx).Muted)}
		}),
	}
	if sending {
		head = append(head, ui.Spinner{Size: 11})
	} else {
		head = append(head, a.pressIcon(lucide.X, apptext.T("关闭"), 26, 13, nil, a.cancelAsk, "mobile-ask-close"))
	}
	footer := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Wrap: core.Wrap}, Children: []core.Node{
		ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "mobile-ask-cancel",
			Disabled: func() bool { return sending }, OnPress: a.cancelAsk},
		core.View{Style: core.Style{FlexGrow: 1}},
		core.Dynamic(func(cx *core.Scope) core.Node {
			return ui.Button{Text: apptext.T("提交"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "mobile-ask-submit",
				Disabled: func() bool { return sending || settled() < len(ask.Questions) }, OnPress: a.submitAskAnswers}
		}),
	}}
	return core.View{TestID: "mobile-ask", StyleFunc: func() core.Style { return askCardStyle(colors) }, Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7}, Children: head},
		core.Scroll{Style: core.Style{MaxHeight: core.Pt(320)}, Children: []core.Node{
			core.View{Style: core.Style{Gap: 12, Padding: core.Edges{Top: 2, Right: viewkit.PanelInset, Bottom: 2}}, Children: rows}}},
		footer,
	}}
}

// askQuestionRow is one question of a batch: what it asks, its choices or
// its field, and whether it was let go.
func (a *mobileApp) askQuestionRow(cx *core.Scope, index int, q remotewire.AskQuestion, sending bool) core.Node {
	colors := ui.ColorsOf(cx)
	answer, answered := a.askAnswer(q.ID)
	skipped := answered && answer.Skipped
	title := []core.Node{
		core.Text{Content: fmt.Sprint(index + 1), Style: core.Style{FontSize: 10, FontFamily: viewkit.MonoFont()},
			StyleFunc: ui.Colored(colors.Faint)},
		core.Text{Content: q.Question, Style: core.Style{LineHeight: 18, FontSize: 12.5, FontWeight: ui.Medium,
			FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Text)},
	}
	if skipped {
		title = append(title, ui.Text(apptext.T("已跳过"), 10.5, ui.Regular, colors.Faint))
	} else if answered {
		title = append(title, ui.Icon(lucide.Check, 12, colors.Up))
	}
	var body []core.Node
	switch q.Type {
	case "confirm":
		body = append(body, core.View{Style: core.Style{Direction: core.Row, Gap: 6, Wrap: core.Wrap}, Children: []core.Node{
			a.askChoice(q, apptext.T("是"), true, "", sending),
			a.askChoice(q, apptext.T("否"), false, "", sending),
		}})
	case "select", "multi_select":
		chips := make([]core.Node, 0, len(q.Options))
		for _, opt := range q.Options {
			chips = append(chips, a.askOptionChip(q, opt, sending))
		}
		body = append(body, core.View{Style: core.Style{Direction: core.Row, Gap: 6, Wrap: core.Wrap}, Children: chips})
		if q.AllowOther {
			body = append(body, a.askTextField(cx, q, sending))
		}
	case "input", "editor":
		body = append(body, a.askTextField(cx, q, sending))
	default:
		body = append(body, a.askTextField(cx, q, sending))
	}
	skipLabel := apptext.T("跳过这题")
	if skipped {
		skipLabel = apptext.T("取消跳过")
	}
	body = append(body, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
		core.View{OnPress: func(core.PressEvent) { a.toggleAskSkip(q) }, Role: core.RoleButton, Label: skipLabel,
			TestID: fmt.Sprintf("mobile-ask-skip-%d", index),
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 3, MinHeight: core.Pt(24),
					CornerRadius: 6, Active: &core.Style{Background: colors.Pressed()}}
			}, Children: []core.Node{
				ui.Icon(lucide.SkipForward, 11, colors.Faint),
				ui.Text(skipLabel, 10.5, ui.Medium, colors.Faint),
			}},
	}})
	return core.View{TestID: fmt.Sprintf("mobile-ask-question-%d", index), Style: core.Style{Gap: 6},
		Children: []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: title},
			core.View{Style: core.Style{Gap: 5, Padding: core.Edges{Left: 10}}, Children: body},
		}}
}

// askChoice is one button of a yes/no question.
func (a *mobileApp) askChoice(q remotewire.AskQuestion, label string, value bool, testID string, sending bool) core.Node {
	colors := ui.ColorsOf(a.cx)
	on := func() bool {
		answer, ok := a.askAnswer(q.ID)
		if !ok || answer.Skipped {
			return false
		}
		yes, isBool := answer.Value.(bool)
		return isBool && yes == value
	}
	return core.View{OnPress: func(core.PressEvent) {
		if sending {
			return
		}
		a.setAskAnswer(remotewire.AskAnswer{ID: q.ID, Type: q.Type, Value: value, Label: label})
	}, Role: core.RoleButton, Label: label, TestID: testID,
		StyleFunc: func() core.Style {
			st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, MinHeight: core.Pt(30),
				Padding: core.Symmetric(0, 12), CornerRadius: 15, BorderWidth: 1,
				BorderColor: colors.FieldBorder(), Background: colors.Surface(), Active: &core.Style{Background: colors.Pressed()}}
			if on() {
				st.Background = colors.Light()
				st.BorderColor = colors.Light()
			}
			return st
		},
		Children: []core.Node{core.Text{Content: label, Style: core.Style{FontSize: 12, FontWeight: ui.Medium},
			StyleFunc: ui.Colored(func() core.Color {
				if on() {
					return colors.OnLight()
				}
				return colors.Text()
			})}}}
}

// askOptionChip is one choice of a select or multi_select question.
func (a *mobileApp) askOptionChip(q remotewire.AskQuestion, opt remotewire.AskOption, sending bool) core.Node {
	colors := ui.ColorsOf(a.cx)
	value := opt.Value
	if value == "" {
		value = opt.Label
	}
	on := func() bool {
		answer, ok := a.askAnswer(q.ID)
		if !ok || answer.Skipped {
			return false
		}
		switch v := answer.Value.(type) {
		case string:
			return v == value
		case []string:
			for _, one := range v {
				if one == value {
					return true
				}
			}
		}
		return false
	}
	press := func() {
		if sending {
			return
		}
		if q.Type == "multi_select" {
			a.toggleAskMulti(q, value, opt.Label)
			return
		}
		a.setAskAnswer(remotewire.AskAnswer{ID: q.ID, Type: q.Type, Value: value, Label: opt.Label})
	}
	children := []core.Node{core.Text{Content: opt.Label, Style: core.Style{FontSize: 12, FontWeight: ui.Medium},
		StyleFunc: ui.Colored(func() core.Color {
			if on() {
				return colors.OnLight()
			}
			return colors.Text()
		})}}
	if strings.TrimSpace(opt.Description) != "" && q.Type != "multi_select" {
		// A select shows why a choice exists under it; a multi_select keeps
		// its chips on one line.
		children = append(children, core.Text{Content: opt.Description, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
			Style: core.Style{FontSize: 10, LineHeight: 14},
			StyleFunc: ui.Colored(func() core.Color {
				if on() {
					return ui.Alpha(colors.OnLight(), 0.75)
				}
				return colors.Faint()
			})})
	}
	return core.View{OnPress: func(core.PressEvent) { press() }, Role: core.RoleButton, Label: opt.Label,
		TestID: "mobile-ask-option",
		StyleFunc: func() core.Style {
			st := core.Style{Direction: core.Column, Gap: 1, MinWidth: core.Pt(0), MaxWidth: core.Pct(100),
				Padding: core.Symmetric(6, 12), CornerRadius: 14, BorderWidth: 1,
				BorderColor: colors.FieldBorder(), Background: colors.Surface(), Active: &core.Style{Background: colors.Pressed()}}
			if on() {
				st.Background = colors.Light()
				st.BorderColor = colors.Light()
			}
			return st
		},
		Children: children}
}

// askTextField is the typed half of a question: an input or editor, or the
// line a select keeps for an answer it did not offer.
func (a *mobileApp) askTextField(cx *core.Scope, q remotewire.AskQuestion, sending bool) core.Node {
	colors := ui.ColorsOf(cx)
	placeholder := q.Placeholder
	if placeholder == "" {
		placeholder = apptext.T("输入回答")
	}
	return core.Input{Value: func() string { return a.askTextValue(q) },
		OnChange: func(text string) {
			if !sending {
				a.setAskText(q.ID, text)
			}
		},
		Multiline: q.Type == "editor", Placeholder: apptext.T(placeholder), Label: apptext.T("回答"),
		TestID: "mobile-ask-input",
		Style: core.Style{MinHeight: core.Pt(34), MaxHeight: core.Pt(120), Padding: core.Symmetric(7, 9), FontSize: 12.5,
			LineHeight: 18, Color: colors.Text(), Background: colors.Field(), BorderWidth: 1,
			BorderColor: colors.FieldBorder(), CornerRadius: 8, PlaceholderColor: colors.Faint(),
			CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}}
}

// simpleAskCard is one question or a permission: the bar the phone has
// always had above the composer.
func (a *mobileApp) simpleAskCard(cx *core.Scope, ask *remotewire.Ask) core.Node {
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
	return core.View{TestID: "mobile-ask", StyleFunc: func() core.Style { return askCardStyle(colors) }, Children: children}
}
