package client

import (
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

type mobileFileEditor struct {
	project, path string
	request       int
	text          *core.Signal[string]
	open          *core.Signal[bool]
	writable      *core.Signal[bool]
	saving        *core.Signal[bool]
	revision      *core.Signal[string]
	err           *core.Signal[string]
}

func newMobileFileEditor(cx *core.Scope) mobileFileEditor {
	return mobileFileEditor{text: core.NewSignal(cx, ""), open: core.NewSignal(cx, false), writable: core.NewSignal(cx, false),
		saving: core.NewSignal(cx, false), revision: core.NewSignal(cx, ""), err: core.NewSignal(cx, "")}
}

func (e *mobileFileEditor) reset(project, path string) {
	e.project, e.path = project, path
	e.request++
	e.text.Set("")
	e.open.Set(false)
	e.writable.Set(false)
	e.saving.Set(false)
	e.revision.Set("")
	e.err.Set("")
}

func (a *mobileApp) closeFileView() {
	if a.fileEdit.open.GetUntracked() {
		return
	}
	a.fileEdit.reset("", "")
	a.fileBusy.Set(false)
	a.fileOpen.Set(false)
	a.fileTitle.Set("")
	a.fileText.Set("")
	a.fileErr.Set("")
	a.fileFind.Set("")
}

func (a *mobileApp) fileEditorBody(colors ui.Colors) core.Node {
	e := &a.fileEdit
	return core.View{Style: core.Style{Gap: 6}, Children: []core.Node{
		core.Input{Value: e.text.Get, OnChange: e.text.Set, Multiline: true,
			Label: apptext.T("编辑文本"), TestID: "mobile-file-editor", Style: core.Style{Height: core.Pt(300),
				Padding: core.Symmetric(8, 10), CornerRadius: ui.RadiusControl, FontFamily: viewkit.MonoFont(), FontSize: 13,
				TextAlignVertical: core.TextAlignVerticalTop, Color: colors.Text(), Background: colors.Field()}},
		core.Text{ContentFunc: e.err.Get, Style: core.Style{FontSize: 12}, StyleFunc: ui.Colored(colors.Danger)},
	}}
}

func (a *mobileApp) fileEditorActions() []core.Node {
	e := &a.fileEdit
	if e.open.Get() {
		return []core.Node{
			ui.Button{Text: apptext.T("放弃修改"), Variant: ui.ButtonGhost, TestID: "mobile-file-discard", Disabled: e.saving.Get,
				OnPress: func() { e.open.Set(false); e.err.Set("") }},
			ui.Button{Text: apptext.T("保存"), TestID: "mobile-file-save", Disabled: func() bool {
				return e.saving.Get() || !e.writable.Get()
			}, OnPress: a.submitFileEdit},
		}
	}
	rows := []core.Node{ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: a.closeFileView}}
	if e.writable.Get() && e.revision.Get() != "" {
		rows = append(rows, ui.Button{Text: apptext.T("编辑"), Size: ui.SizeSmall, TestID: "mobile-file-edit", OnPress: func() {
			e.text.Set(strings.ReplaceAll(a.fileText.GetUntracked(), "\r\n", "\n"))
			e.err.Set("")
			e.open.Set(true)
		}})
	}
	return rows
}

func (a *mobileApp) submitFileEdit() {
	e, client := &a.fileEdit, a.client
	if client == nil || e.saving.GetUntracked() || !e.writable.GetUntracked() {
		return
	}
	text := e.text.GetUntracked()
	old := a.fileText.GetUntracked()
	if strings.Count(old, "\r\n") > 0 && strings.Count(old, "\r\n") == strings.Count(old, "\n") {
		text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\n", "\r\n")
	}
	if text == old {
		e.open.Set(false)
		return
	}
	request := e.request
	req := remotewire.FileWrite{Project: e.project, Path: e.path, Text: text, Revision: e.revision.GetUntracked()}
	e.err.Set("")
	e.saving.Set(true)
	go func() {
		file, err := client.saveFile(req)
		a.cx.Post(func() {
			if a.client != client || e.request != request {
				return
			}
			e.saving.Set(false)
			if err != nil {
				e.err.Set(remoteErrorText(err))
				return
			}
			e.revision.Set(file.Revision)
			a.fileText.Set(text)
			e.open.Set(false)
		})
	}()
}
