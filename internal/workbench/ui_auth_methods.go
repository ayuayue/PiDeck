//go:build !js && !android && !ios

package workbench

import (
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) authMethodsDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		if a.authMethodsOpen == nil {
			return core.Group(nil)
		}
		providers := a.authMethods.Get()
		query := strings.ToLower(strings.TrimSpace(a.authMethodsQuery.Get()))
		var options []ui.Option[string]
		for _, provider := range providers {
			if query != "" && !strings.Contains(strings.ToLower(provider.ID+" "+provider.Name), query) {
				continue
			}
			options = append(options, ui.Option[string]{Value: provider.ID, Label: authProviderLabel(provider)})
		}
		selected, found := matchingAuthProvider(providers, a.authMethodsProvider.Get())
		colors := ui.ColorsOf(cx)
		var details []core.Node
		if found {
			if selected.APIKey != nil {
				label := apptext.T("使用 Pi 配置 API Key")
				if !selected.APIKey.Login {
					label = apptext.T("手动录入 API Key")
				}
				if selected.APIKey.Name != "" {
					label = selected.APIKey.Name
				}
				details = append(details, ui.Button{Text: label, Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
					TestID: "auth-method-login-key", OnPress: func() {
						if selected.APIKey.Login {
							a.authLoginAPIKey(selected.ID)
						} else {
							a.authMethodsOpen.Set(false)
							a.openAuthKey(selected.ID)
						}
					}})
			}
			if selected.OAuth != nil {
				label := selected.OAuth.LoginLabel
				if label == "" {
					label = apptext.T("OAuth 登录")
				}
				details = append(details,
					ui.Button{Text: label, Variant: ui.ButtonPrimary, Size: ui.SizeSmall,
						TestID: "auth-method-login-oauth", OnPress: func() { a.authLogin(selected.ID) }},
					ui.Button{Text: apptext.T("无浏览器登录"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						TestID: "auth-method-login-oauth-no-browser", OnPress: func() { a.authLoginNoBrowser(selected.ID) }},
				)
			}
			if selected.APIKey != nil && selected.APIKey.Name != "" {
				details = append(details, core.Text{Content: selected.APIKey.Name, MaxLines: 2,
					Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Faint)})
			}
			if selected.OAuth != nil && selected.OAuth.Name != "" {
				details = append(details, core.Text{Content: selected.OAuth.Name, MaxLines: 2,
					Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Faint)})
			}
		}
		if a.authMethodsBusy.Get() {
			details = append(details, core.Text{Content: apptext.T("正在读取 Pi 支持的认证方式…"),
				Style: core.Style{FontSize: 11, Padding: core.Symmetric(4, 0)}, StyleFunc: ui.Colored(colors.Muted)})
		}
		if errText := a.authMethodsError.Get(); errText != "" {
			details = append(details, core.Text{Content: errText, MaxLines: 3,
				Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Danger)})
		}
		if len(providers) == 0 && !a.authMethodsBusy.Get() && a.authMethodsError.Get() == "" {
			details = append(details, core.Text{Content: apptext.T("没有找到 Pi 支持的认证方式。"),
				Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)})
		}
		return ui.Dialog{
			Open: a.authMethodsOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) {
				a.authMethodsOpen.Set(open)
			},
			Title: apptext.T("Pi 内置认证方式"), TestID: "auth-methods-dialog",
			Style: core.Style{Width: a.dialogWidth(), MaxHeight: core.Pt(440)},
			Children: []core.Node{
				core.Text{Content: apptext.T("选择 Pi 支持的供应商；Pi 会在终端完成 API Key、OAuth 或设备授权，并写入 auth.json。"),
					Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Muted)},
				ui.Input{Value: a.authMethodsQuery.Get, OnChange: a.authMethodsQuery.Set,
					Placeholder: apptext.T("搜索供应商"), Label: apptext.T("搜索供应商"), TestID: "auth-methods-search"},
				ui.Select[string]{Options: options, Value: a.authMethodsProvider.Get, OnChange: a.authMethodsProvider.Set,
					Placeholder: apptext.T("选择供应商"), Label: apptext.T("供应商"), TestID: "auth-methods-provider"},
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, AlignItems: core.AlignCenter, Gap: 7}, Children: details},
			},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("自定义密钥"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "auth-method-custom",
					OnPress: func() { a.authMethodsOpen.Set(false); a.openAuthKey("") }},
				core.View{Style: core.Style{FlexGrow: 1}},
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.authMethodsOpen.Set(false) }},
			},
		}
	})
}
