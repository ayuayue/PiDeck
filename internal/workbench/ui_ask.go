//go:build !js && !android && !ios

package workbench

// The parallel inquiry dialog: a question, optional background from the
// main conversation, and the answer once the ask session finishes.

import (
	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// askDialog is the parallel inquiry window.
func (a *app) parallelAskDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		st := a.askBox.Get()
		set := func(fn func(*askBox)) {
			v := a.askBox.GetUntracked()
			fn(&v)
			a.askBox.Set(v)
		}
		status := askStatus(st)
		statusColor := colors.Muted
		if st.Err != "" {
			statusColor = colors.Danger
		}
		hasAnswer := st.Answer != ""
		canStart := !st.Busy
		var answerNode core.Node
		if hasAnswer {
			answerNode = core.View{Style: core.Style{Direction: core.Column, Gap: 4}, Children: []core.Node{
				ui.Text(apptext.T("答案"), 10.5, ui.Medium, colors.Muted),
				core.View{StyleFunc: func() core.Style {
					return core.Style{MaxHeight: core.Pt(220), Padding: core.All(10), CornerRadius: 8,
						BorderWidth: 1, BorderColor: colors.Line(), Background: colors.Inset()}
				}, Children: []core.Node{a.scrollStashFor("parallelAskDialog:1").Bind(cx, core.Scroll{Style: core.Style{MaxHeight: core.Pt(200)}, Children: []core.Node{
					core.View{Selectable: true, Style: core.Style{Padding: core.Edges{Right: viewkit.PanelInset}}, Children: []core.Node{viewkit.Markdown(st.Answer, func() bool { return false }, false)}},
				}})}},
			}}
		}
		buttonRow := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
			ui.Button{Text: apptext.T("开始问"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "ask-start",
				Disabled: func() bool { return !canStart }, OnPress: func() { a.startAsk() }},
			ui.Button{Text: apptext.T("插入到输入框"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "ask-insert",
				Disabled: func() bool { return !hasAnswer }, OnPress: func() { a.insertAskAnswer() }},
			ui.Button{Text: apptext.T("复制答案"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "ask-copy",
				Disabled: func() bool { return !hasAnswer }, OnPress: func() { a.copyAskAnswer() }},
			ui.Button{Text: apptext.T("打开这个会话"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "ask-open-session",
				Disabled: func() bool { return st.SessionID == "" }, OnPress: func() { a.openAskSession() }},
			core.View{Style: core.Style{FlexGrow: 1}},
			ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "ask-close",
				OnPress: func() { set(func(v *askBox) { v.Open = false }) }},
		}}
		return ui.Dialog{
			Open: func() bool { return st.Open },
			OnOpenChange: func(open bool, _ base.Reason) {
				if !open {
					set(func(v *askBox) { v.Open = false })
				}
			},
			Title:  apptext.T("并行问询"),
			TestID: "ask-dialog",
			Style:  core.Style{Width: a.dialogWidth(), Height: core.Pt(560)},
			Children: []core.Node{a.scrollStashFor("parallelAskDialog:2").Bind(cx, core.Scroll{Style: ui.FillRest, Children: []core.Node{
				core.View{Style: core.Style{Gap: 12, Padding: core.Edges{Right: viewkit.PanelInset}}, Children: []core.Node{
					core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
						ui.Text(apptext.T("问题"), 10.5, ui.Medium, colors.Muted),
						core.Input{Value: a.askText.Get, OnChange: a.askText.Set,
							Multiline: true, Placeholder: apptext.T("在另一个会话里问什么？"), Label: apptext.T("问询问题"), TestID: "ask-text",
							Style: core.Style{Height: core.Pt(96), Padding: core.Symmetric(8, 10), CornerRadius: 8,
								Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(),
								Color: colors.Text(), FontSize: 12.5, LineHeight: 18}},
					}},
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
						ui.Checkbox{Checked: func() bool { return a.askBox.GetUntracked().WithContext },
							OnChange: func(on bool) { set(func(v *askBox) { v.WithContext = on }) },
							Text:     apptext.T("带上当前会话最近的上下文"), Label: apptext.T("带上当前会话最近的上下文"), TestID: "ask-context"},
					}},
					core.Show{When: func() bool { return status != "" }, Then: func(*core.Scope) core.Node {
						return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7}, Children: []core.Node{
							core.Show{When: func() bool { return a.askBox.GetUntracked().Busy }, Then: func(*core.Scope) core.Node {
								return ui.Spinner{Size: 12}
							}},
							core.Text{ContentFunc: func() string { return askStatus(a.askBox.GetUntracked()) },
								MaxLines: 3, Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(statusColor)},
						}}
					}},
					answerNode,
					buttonRow,
					core.Text{Content: apptext.T("问询会新建一个会话，主会话不受影响；答完可以引用回输入框，也可以打开那个会话继续聊。"),
						Style: core.Style{FontSize: 10.5, LineHeight: 16}, StyleFunc: ui.Colored(colors.Faint)},
				}},
			}})},
		}
	})
}

// askIcon is the dialog's command icon.
var askIcon = lucide.MessagesSquare
