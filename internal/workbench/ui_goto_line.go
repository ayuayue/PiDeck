//go:build !js && !android && !ios

package workbench

// Go to a line in the editor.

import (
	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// gotoLineDialog asks for a line number and moves the caret there.
func (a *app) gotoLineDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return ui.Dialog{
			Open:         a.gotoOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.gotoOpen.Set(open) },
			// The modal traps keyboard focus until it finishes closing.
			OnClose: func() {
				if f := a.editor.activeFile(); f != nil && f.ref != nil {
					f.ref.Focus()
				}
			},
			Title:  apptext.T("转到行"),
			TestID: "goto-line",
			Style:  core.Style{Width: core.Pt(360)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 8}, Children: []core.Node{
				core.Text{Content: apptext.T("输入行号，回车跳到那一行。"), Style: core.Style{FontSize: 11.5},
					StyleFunc: ui.Colored(colors.Muted)},
				core.Input{Value: a.gotoLine.Get, OnChange: a.gotoLine.Set, Placeholder: "1", Label: apptext.T("行号"),
					TestID: "goto-line-input", AutoFocus: true, OnSubmit: func(string) { a.jumpToLine() },
					Style: core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 9), CornerRadius: 7,
						Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(),
						Color: colors.Text(), FontSize: 12.5, FontFamily: viewkit.MonoFont()}},
			}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.gotoOpen.Set(false) }},
				ui.Button{Text: apptext.T("转到"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "goto-line-go",
					OnPress: func() { a.jumpToLine() }},
			},
		}
	})
}
