//go:build !js && !android && !ios

package workbench

// The dialog that starts a plugin.

import (
	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// openPluginNew shows the dialog with empty fields.
func (a *app) openPluginNew() {
	a.pluginNewID.Set("")
	a.pluginNewName.Set("")
	a.pluginNewDesc.Set("")
	a.pluginNewOpen.Set(true)
}

// pluginNewDialog asks for a new plugin's id, name and description.
func (a *app) pluginNewDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		field := func(value *core.Signal[string], label, placeholder, testID string) core.Node {
			return core.View{Style: core.Style{Gap: 3}, Children: []core.Node{
				core.Text{Content: label, Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
				core.Input{Value: value.Get, OnChange: value.Set, Placeholder: placeholder, Label: label, TestID: testID,
					Style: core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 9), CornerRadius: 7, FontSize: 12,
						Color: colors.Text(), Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder()}},
			}}
		}
		return ui.Dialog{
			Open:         a.pluginNewOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.pluginNewOpen.Set(open) },
			Title:        apptext.T("新建插件"),
			Description:  apptext.T("插件文件夹里是一个 plugin.json：命令、设置、主题、键位、钩子和智能体都写在 contributes 里；保存后回到设置 → 插件点「重新加载」。"),
			TestID:       "plugin-new",
			Style:        core.Style{Width: a.dialogWidth()},
			Children: []core.Node{core.View{Style: core.Style{Gap: 10}, Children: []core.Node{
				field(a.pluginNewID, apptext.T("插件 id"), "my-tools", "plugin-new-id"),
				field(a.pluginNewName, apptext.T("插件名"), apptext.T("例如 我的工具"), "plugin-new-name"),
				field(a.pluginNewDesc, apptext.T("说明"), apptext.T("可选：这个插件做什么。"), "plugin-new-desc"),
				core.Text{Content: apptext.T("id 决定文件夹名，只能用一次；名字和说明只是给人看的。"),
					Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)},
			}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.pluginNewOpen.Set(false) }},
				ui.Button{Text: apptext.T("创建"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "plugin-new-create", Disabled: a.pluginFileBusy.Get,
					OnPress: a.createPluginFromDialog},
			},
		}
	})
}
