//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

type promptTemplateForm struct {
	text, message *core.Signal[string]
	busy          *core.Signal[bool]
}

func (a *app) openPromptTemplate() {
	if a.st == nil || a.promptTemplate.GetUntracked() != nil {
		return
	}
	form := &promptTemplateForm{text: core.NewSignal(a.cx, ""), message: core.NewSignal(a.cx, ""), busy: core.NewSignal(a.cx, true)}
	a.promptTemplate.Set(form)
	go func() {
		text, err := readPromptTemplate(a.st.dir)
		a.cx.Post(func() {
			if a.promptTemplate.GetUntracked() != form {
				return
			}
			form.text.Set(text)
			form.busy.Set(false)
			if err != nil {
				form.message.Set(apptext.T("增强模板不可用，已使用默认模板") + "\n" + apptext.T(err.Error()))
			}
		})
	}()
}

func (a *app) savePromptTemplate(form *promptTemplateForm) {
	if form.busy.GetUntracked() || a.promptTemplate.GetUntracked() != form {
		return
	}
	text := form.text.GetUntracked()
	if err := validatePromptTemplate(text); err != nil {
		form.message.Set(apptext.T(err.Error()))
		return
	}
	form.busy.Set(true)
	form.message.Set("")
	go func() {
		err := savePromptTemplate(a.st.dir, text)
		a.cx.Post(func() {
			if a.promptTemplate.GetUntracked() != form {
				return
			}
			form.busy.Set(false)
			if err != nil {
				form.message.Set(apptext.T(err.Error()))
				return
			}
			a.promptTemplate.Set(nil)
			a.toast(ui.ToastSuccess, "增强模板已保存", "桌面与手机的提示词增强都会使用此模板。")
		})
	}()
}

func (a *app) promptTemplateDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		form := a.promptTemplate.Get()
		if form == nil {
			return nil
		}
		colors := ui.ColorsOf(cx)
		return ui.Dialog{Title: apptext.T("提示词增强模板"), TestID: "prompt-template-dialog", Style: core.Style{Width: a.dialogWidth()},
			Open: func() bool { return a.promptTemplate.Get() != nil }, OnOpenChange: func(open bool, _ base.Reason) {
				if !open && !form.busy.GetUntracked() {
					a.promptTemplate.Set(nil)
				}
			}, Children: []core.Node{
				ui.Text(apptext.T("描述希望如何改写草稿。模板作为系统指令发送，原始草稿会单独提交；不会改变聊天模型。"), 12, ui.Regular, colors.Muted),
				core.Input{Value: form.text.Get, OnChange: form.text.Set, Multiline: true, Disabled: form.busy.Get,
					Label: apptext.T("增强指令"), TestID: "prompt-template-text", Style: draftFieldStyle(colors).Merge(core.Style{Height: core.Pt(230),
						TextAlignVertical: core.TextAlignVerticalTop, FontSize: a.composerFont(), LineHeight: a.composerLine()})},
				core.Text{ContentFunc: form.message.Get, Style: core.Style{FontSize: 12}, StyleFunc: ui.Colored(colors.Danger)},
			}, Footer: []core.Node{
				ui.Button{Text: apptext.T("恢复默认"), Variant: ui.ButtonGhost, TestID: "prompt-template-default", Disabled: form.busy.Get,
					OnPress: func() { form.text.Set(toolSystem("prompt")); form.message.Set("") }},
				ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, TestID: "prompt-template-cancel", Disabled: form.busy.Get,
					OnPress: func() { a.promptTemplate.Set(nil) }},
				ui.Button{Text: apptext.T("保存"), TestID: "prompt-template-save", Disabled: form.busy.Get, OnPress: func() { a.savePromptTemplate(form) }},
			}}
	})
}
