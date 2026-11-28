//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) authKeyDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return ui.Dialog{
			Open: a.authKeyOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) {
				if !open {
					a.closeAuthKey()
				}
			},
			TitleFunc: func() string {
				if _, exists := a.authEntryOf(a.authUI.KeyEditing); exists {
					return apptext.T("替换密钥")
				}
				return apptext.T("添加自定义密钥")
			},
			Description: apptext.T("保存到 pi 使用的 auth.json；不会改动其他供应商。"),
			TestID:      "auth-key", Style: core.Style{Width: a.dialogWidth(), MaxWidth: core.Pt(560)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 10}, Children: []core.Node{
				ui.Text(apptext.T("供应商 ID"), viewkit.PanelCaptionSize, ui.Medium, colors.Text),
				ui.Input{Value: a.authKeyProvider.Get, OnChange: a.authKeyProvider.Set,
					Disabled:    func() bool { return a.authUI.Busy.Get() || a.authUI.KeyEditing != "" },
					Placeholder: "my-provider", Label: apptext.T("供应商 ID"), TestID: "auth-provider"},
				ui.Text(apptext.T("自定义 ID 必须与 models.json 中的供应商一致。"), viewkit.PanelCaptionSize, ui.Regular, colors.Muted),
				a.authKeyField(),
				a.authKeyError(),
				ui.Text(apptext.T("保存后，新启动的 Agent 会使用此凭据；正在运行的 Agent 请重启。"), viewkit.PanelCaptionSize, ui.Regular, colors.Muted),
			}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, TestID: "auth-key-cancel", Disabled: a.authUI.Busy.Get, OnPress: a.closeAuthKey},
				a.authSaveButton("auth-key-save"),
			},
		}
	})
}

func (a *app) authKeyField() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return core.View{Style: core.Style{Gap: 5}, Children: []core.Node{
			ui.Text(apptext.T("API Key"), viewkit.PanelCaptionSize, ui.Medium, colors.Text),
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				core.Dynamic(func(*core.Scope) core.Node {
					return ui.Input{Value: a.authKeyText.Get, OnChange: func(value string) { a.authKeyText.Set(value); a.authUI.Error.Set("") },
						Masked: !a.authUI.ShowKey.Get(), Disabled: a.authUI.Busy.Get, MaxLength: 16384,
						Placeholder: apptext.T("粘贴供应商提供的 API Key"), Label: apptext.T("API Key"), TestID: "auth-key-input",
						Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, OnSubmit: func(string) { a.saveAuthKey() }}
				}),
				authActionButton(ui.Button{TextFunc: func() string {
					if a.authUI.ShowKey.Get() {
						return apptext.T("隐藏")
					}
					return apptext.T("显示")
				},
					Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "auth-key-visibility", OnPress: func() { a.authUI.ShowKey.Set(!a.authUI.ShowKey.GetUntracked()) }}),
			}},
			ui.Text(apptext.T("也支持 $环境变量 和 !命令引用。凭据只保存在本机。"), viewkit.PanelCaptionSize, ui.Regular, colors.Muted),
		}}
	})
}

func (a *app) authKeyError() core.Node {
	return core.Show{When: func() bool { return a.authUI.Error.Get() != "" }, Then: func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return core.Text{ContentFunc: a.authUI.Error.Get, TestID: "auth-key-error", Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: 18}, StyleFunc: ui.Colored(colors.Danger)}
	}}
}

func (a *app) authSaveButton(testID string) core.Node {
	return authActionButton(ui.Button{TextFunc: func() string {
		if a.authUI.Busy.Get() {
			return apptext.T("正在保存…")
		}
		return apptext.T("保存密钥")
	},
		Variant: ui.ButtonPrimary, Disabled: a.authUI.Busy.Get, TestID: testID, OnPress: a.saveAuthKey})
}
