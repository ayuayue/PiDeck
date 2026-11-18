//go:build !js && !android && !ios

package workbench

// The settings window: a rail of sections beside the section's rows. Each
// row says what it is in a line and why in a quieter one, and the control
// sits at its end, so a section reads top to bottom.

import (
	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// authGroup lists pi's credentials file with a way to replace a key.
func (a *app) authGroup() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		entries := a.authEntries.Get()
		errText := a.authErr.Get()
		var rows []core.Node
		for _, e := range entries {
			e := e
			detail := e.Type
			if detail == "" {
				detail = apptext.T("未声明类型")
			}
			if e.Hint != "" {
				detail += " · " + e.Hint
			}
			var controls []core.Node
			if e.Editable {
				controls = append(controls, ui.Button{Text: apptext.T("替换密钥"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
					TestID: "auth-replace-" + e.Provider, OnPress: func() { a.openAuthKey(e.Provider) }})
			}
			controls = append(controls, ui.Button{Text: apptext.T("删除"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				TestID: "auth-delete-" + e.Provider, OnPress: func() { a.dropAuthEntry(e.Provider) }})
			rows = append(rows, setRow(e.Provider, detail, core.View{Style: core.Style{Direction: core.Row, Gap: 6}, Children: controls}))
		}
		if len(entries) == 0 && errText == "" {
			rows = append(rows, setRow(apptext.T("还没有凭据"), apptext.T("在终端里登录 pi，或在这里添加一个 API key。"), nil))
		}
		if errText != "" {
			rows = append(rows, core.Text{Content: errText, Style: core.Style{FontSize: 10.5, Padding: core.Symmetric(3, 6)},
				StyleFunc: ui.Colored(colors.Danger)})
		}
		rows = append(rows, core.View{Style: core.Style{Direction: core.Row, Gap: 6, Margin: core.Edges{Top: 2}}, Children: []core.Node{
			ui.Button{Text: apptext.T("添加密钥…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "auth-add",
				OnPress: func() { a.openAuthKey("") }},
		}})
		return setGroup(apptext.T("pi 凭据"), rows...)
	})
}
