//go:build !js && !android && !ios

package workbench

import (
	"slices"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// askResultBody keeps the original questions and choices beside the answers,
// including choices the user left unselected. It is a read-only transcript.
func (a *app) askResultBody(cx *core.Scope, result askToolResult) core.Node {
	colors := ui.ColorsOf(cx)
	var questions []core.Node
	for _, q := range result.Questions {
		answer := result.answer(q)
		body := []core.Node{core.Text{Content: q.Question, Selectable: core.SelectableOn,
			Style:     core.Style{FontSize: a.readingRowFont(), LineHeight: a.readingRowLine(), FontWeight: ui.Medium},
			StyleFunc: ui.Colored(colors.Text)}}
		options := q.Options
		if q.Type == askConfirm {
			options = []askOption{{Label: apptext.T("是"), Value: "true"}, {Label: apptext.T("否"), Value: "false"}}
		}
		values, _ := askStringList(answer.Value)
		for _, opt := range options {
			selected := false
			if !answer.Skipped && !answer.WasCustom {
				switch value := answer.Value.(type) {
				case string:
					selected = value == opt.Value
				case bool:
					selected = (value && opt.Value == "true") || (!value && opt.Value == "false")
				default:
					selected = slices.Contains(values, opt.Value)
				}
			}
			body = append(body, a.askResultOption(cx, q.ID, opt, selected))
		}
		text := ""
		switch {
		case answer.Skipped:
			text = apptext.T("已跳过")
		case !answer.answered():
			text = apptext.T("未作答")
		case len(options) == 0 || answer.WasCustom:
			text = answer.Label
		}
		if text != "" {
			body = append(body, core.Text{Content: text, Selectable: core.SelectableOn,
				Style:     core.Style{FontSize: a.readingDetailFont(), LineHeight: a.readingDetailLine()},
				StyleFunc: ui.Colored(colors.Muted)})
		}
		questions = append(questions, core.View{TestID: "ask-result-" + q.ID,
			Style: core.Style{MinWidth: core.Pt(0), Gap: 4}, Children: body})
	}
	return core.View{TestID: "ask-result", Style: core.Style{MinWidth: core.Pt(0), Gap: 14}, Children: questions}
}

func (a *app) askResultOption(cx *core.Scope, questionID string, opt askOption, selected bool) core.Node {
	colors := ui.ColorsOf(cx)
	ink := colors.Muted
	weight := ui.Regular
	icon := lucide.Square
	markID := ""
	if selected {
		ink, weight, icon = colors.Text, ui.Medium, lucide.SquareCheck
		markID = "ask-result-selected-" + questionID + "-" + opt.Value
	}
	label := []core.Node{core.Text{Content: opt.Label, Selectable: core.SelectableOn,
		Style:     core.Style{FontSize: a.readingDetailFont(), LineHeight: a.readingDetailLine(), FontWeight: weight},
		StyleFunc: ui.Colored(ink)}}
	if opt.Description != "" {
		label = append(label, core.Text{Content: opt.Description, Selectable: core.SelectableOn,
			Style:     core.Style{FontSize: a.readingDetailFont(), LineHeight: a.readingDetailLine()},
			StyleFunc: ui.Colored(colors.Muted)})
	}
	return core.View{Role: core.RoleCheckbox, Label: opt.Label, Checked: func() bool { return selected },
		Disabled: func() bool { return true },
		Style: core.Style{Direction: core.Row, AlignItems: core.AlignStart, Gap: 7,
			Padding: core.Symmetric(3, 4), MinWidth: core.Pt(0)}, Children: []core.Node{
			core.View{TestID: markID, Style: core.Style{Padding: core.Edges{Top: 2}}, Children: []core.Node{
				ui.Icon(icon, 13, ink),
			}},
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: label},
		}}
}
