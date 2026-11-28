//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) authMethodsDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		selected := core.NewMemo(cx, func() string { return a.authMethodsProvider.Get() })
		return ui.Dialog{
			Open: a.authMethodsOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) {
				if !open && !a.authUI.Busy.GetUntracked() {
					a.authMethodsOpen.Set(false)
					a.authKeyText.Set("")
				}
			},
			TitleFunc: func() string {
				if a.authUI.Mode.Get() == "oauth" {
					return apptext.T("登录账号")
				}
				return apptext.T("添加 API 密钥")
			},
			Description: apptext.T("供应商和认证方式来自当前安装的 pi。"), TestID: "auth-methods-dialog",
			Style: core.Style{Width: a.dialogWidth(), MaxWidth: core.Pt(560), MinHeight: core.Pt(400), MaxHeight: core.Pt(600)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 12}, Children: []core.Node{
				ui.Select[string]{OptionsFunc: func() []ui.Option[string] {
					var options []ui.Option[string]
					for _, provider := range a.authMethods.Get() {
						if a.authUI.Mode.Get() == "oauth" && provider.OAuth == nil {
							continue
						}
						if a.authUI.Mode.Get() != "oauth" && provider.APIKey == nil {
							continue
						}
						options = append(options, ui.Option[string]{Value: provider.ID, Label: authProviderLabel(provider)})
					}
					return options
				}, Value: selected.Get, OnChange: func(id string) {
					a.authMethodsProvider.Set(id)
					a.authKeyProvider.Set(id)
					a.authKeyText.Set("")
					a.authUI.Error.Set("")
				}, Searchable: true, SearchPlaceholder: apptext.T("搜索供应商"), Empty: apptext.T("没有匹配的供应商"),
					Placeholder: apptext.T("选择供应商"), Label: apptext.T("供应商"), TestID: "auth-methods-provider", Disabled: a.authUI.Busy.Get,
					Style: core.Style{Width: core.Pct(100)}},
				core.Dynamic(func(*core.Scope) core.Node {
					provider, found := matchingAuthProvider(a.authMethods.Get(), selected.Get())
					mode := a.authUI.Mode.Get()
					if !found || (mode == "oauth" && provider.OAuth == nil) || (mode != "oauth" && provider.APIKey == nil) {
						return ui.Text(apptext.T("先选择供应商，再填写密钥或登录账号。"), viewkit.PanelCaptionSize, ui.Regular, colors.Muted)
					}
					var nodes []core.Node
					if entry, exists := a.authEntryOf(provider.ID); exists {
						text := apptext.T("此供应商已有凭据，保存后将替换现有认证。")
						if entry.Type == "oauth" && mode == "oauth" {
							text = apptext.T("此账号已登录；重新登录会更新本机凭据。")
						}
						nodes = append(nodes, ui.Text(text, viewkit.PanelCaptionSize, ui.Medium, colors.Text))
					}
					if mode == "oauth" {
						nodes = append(nodes, ui.Text(apptext.T("点击登录后，在浏览器完成授权，再回到此窗口。设备码和授权码会在这里提示。"), viewkit.PanelCaptionSize, ui.Regular, colors.Muted),
							core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
								authActionButton(ui.Button{Text: apptext.T("登录账号"), Variant: ui.ButtonPrimary, TestID: "auth-method-login-oauth", Disabled: a.authUI.Busy.Get, OnPress: func() { a.authLogin(provider.ID) }}),
								authActionButton(ui.Button{Text: apptext.T("手动打开授权页"), Variant: ui.ButtonSecondary, TestID: "auth-method-login-oauth-no-browser", Disabled: a.authUI.Busy.Get, OnPress: func() { a.authLoginNoBrowser(provider.ID) }}),
							}})
					} else if provider.APIKey != nil && provider.APIKey.Login {
						nodes = append(nodes, a.authKeyField(), a.authSaveButton("auth-method-login-key"),
							authActionButton(ui.Button{Text: apptext.T("其他配置方式"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "auth-method-key-advanced", OnPress: func() { a.authLoginAPIKey(provider.ID) }}))
					} else {
						nodes = append(nodes, ui.Text(apptext.T("此供应商使用环境变量或云平台凭据，不支持直接保存 API Key。"), viewkit.PanelCaptionSize, ui.Regular, colors.Muted),
							ui.Text(provider.APIKey.Name, viewkit.PanelCaptionSize, ui.Medium, colors.Text))
					}
					return core.View{Style: core.Style{Gap: 10}, Children: nodes}
				}),
				a.authKeyError(),
				core.Show{When: a.authMethodsBusy.Get, Then: func(*core.Scope) core.Node {
					return ui.Text(apptext.T("正在读取 Pi 支持的认证方式…"), viewkit.PanelCaptionSize, ui.Regular, colors.Muted)
				}},
				core.Show{When: func() bool { return a.authMethodsError.Get() != "" }, Then: func(*core.Scope) core.Node {
					return core.View{Style: core.Style{Gap: 8}, Children: []core.Node{
						core.Text{ContentFunc: a.authMethodsError.Get, Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: 18}, StyleFunc: ui.Colored(colors.Danger)},
						authActionButton(ui.Button{Text: apptext.T("重试"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "auth-methods-retry", OnPress: a.loadAuthMethods}),
					}}
				}},
			}}},
			Footer: []core.Node{
				authActionButton(ui.Button{Text: apptext.T("自定义供应商"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "auth-method-custom", Disabled: a.authUI.Busy.Get,
					OnPress: func() { a.authMethodsOpen.Set(false); a.openAuthKey("") }}),
				core.View{Style: core.Style{FlexGrow: 1}},
				authActionButton(ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Disabled: a.authUI.Busy.Get,
					OnPress: func() { a.authMethodsOpen.Set(false); a.authKeyText.Set("") }}),
			},
		}
	})
}
