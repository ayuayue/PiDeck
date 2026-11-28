//go:build !js && !android && !ios

package workbench

import (
	"strings"
	"time"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) settingsCredentials() core.Node {
	return a.providerSettingsPage("settings-page", a.authGroup(), a.authOAuthGroup(), a.authProxyGroup())
}

// authGroup is the auth.json source of truth: each row represents one stored
// API key or OAuth credential, without mixing in provider configuration.
func (a *app) authGroup() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		entries := a.authEntries.Get()
		errText := a.authErr.Get()
		now := cx.Now()
		var rows []core.Node
		for i, e := range entries {
			e := e
			var controls []core.Node
			if e.Type == "oauth" {
				controls = append(controls, ui.Button{Text: apptext.T("重新登录"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
					Disabled: a.authUI.Busy.Get, TestID: "auth-relogin-" + e.Provider, OnPress: func() { a.authLogin(e.Provider) }})
			}
			controls = append(controls, ui.Button{Text: apptext.T("检测"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				Disabled: a.authUI.Busy.Get, TestID: "auth-check-" + e.Provider, OnPress: func() { a.authCheck(e.Provider) }})
			if e.Editable {
				controls = append(controls, ui.Button{Text: apptext.T("替换密钥"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
					Disabled: a.authUI.Busy.Get, TestID: "auth-replace-" + e.Provider, OnPress: func() { a.openAuthKey(e.Provider) }})
			}
			controls = append(controls, ui.Button{Text: apptext.T("删除"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				Disabled: a.authUI.Busy.Get, TestID: "auth-delete-" + e.Provider, OnPress: func() { a.dropAuthEntry(e.Provider) }})
			rows = append(rows, setRow(a.authProviderName(e.Provider), a.authEntryDetail(e, now),
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, AlignItems: core.AlignCenter, Gap: 6}, Children: controls}))
			if i < len(entries)-1 {
				rows = append(rows, setDivider())
			}
		}
		if len(entries) == 0 && errText == "" {
			rows = append(rows, setRow(apptext.T("还没有凭据"), apptext.T("有 API Key 就添加密钥；使用订阅账号则选择登录账号。"), nil))
		}
		if errText != "" {
			rows = append(rows, core.Text{Content: errText, Style: core.Style{FontSize: 10.5, Padding: core.Symmetric(3, 6)},
				StyleFunc: ui.Colored(colors.Danger)})
		}
		rows = append(rows,
			setDivider(),
			core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				ui.Button{Text: apptext.T("添加 API 密钥"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, Disabled: a.authUI.Busy.Get, TestID: "auth-add",
					OnPress: a.openAuthMethods},
				ui.Button{Text: apptext.T("登录账号"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, Disabled: a.authUI.Busy.Get, TestID: "auth-add-oauth",
					OnPress: func() { a.openAuthMethod("oauth") }},
				ui.Button{Text: apptext.T("添加自定义密钥"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, Disabled: a.authUI.Busy.Get, TestID: "auth-add-custom",
					OnPress: func() { a.openAuthKey("") }},
				ui.Button{Text: apptext.T("刷新状态"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, Disabled: a.authUI.Busy.Get, TestID: "auth-check-all",
					OnPress: func() { a.loadAuth(); a.refreshProviders() }},
				ui.Button{Text: apptext.T("编辑 auth.json"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.openPiConfigFile("auth.json") }},
			}})
		return setGroup("已保存的凭据", rows...)
	})
}

func (a *app) authProviderName(id string) string {
	if provider, ok := matchingAuthProvider(a.authMethods.Get(), id); ok {
		return authProviderLabel(provider)
	}
	return id
}

func (a *app) authOAuthGroup() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		var rows []core.Node
		for _, provider := range a.authMethods.Get() {
			if provider.OAuth == nil {
				continue
			}
			if len(rows) > 0 {
				rows = append(rows, setDivider())
			}
			provider := provider
			status, action := apptext.T("未登录"), apptext.T("登录账号")
			if entry, ok := a.authEntryOf(provider.ID); ok && entry.Type == "oauth" {
				status, action = apptext.T("已登录"), apptext.T("重新登录")
				if entry.Expires > 0 && entry.Expires <= cx.Now().UnixMilli() {
					if entry.Refreshable {
						status = apptext.T("已登录 · 可自动续期")
					} else {
						status = apptext.T("登录已过期，请重新登录")
					}
				}
			}
			if provider.OAuth.Name != "" {
				status += " · " + provider.OAuth.Name
			}
			rows = append(rows, setRow(authProviderLabel(provider), status,
				ui.Button{Text: action, Variant: ui.ButtonSecondary, Size: ui.SizeSmall, Disabled: a.authUI.Busy.Get,
					TestID: "auth-oauth-" + provider.ID, OnPress: func() { a.authLogin(provider.ID) }}))
		}
		if a.authMethodsBusy.Get() {
			rows = append(rows, ui.Text(apptext.T("正在读取 Pi 支持的认证方式…"), viewkit.PanelCaptionSize, ui.Regular, colors.Muted))
		} else if errText := a.authMethodsError.Get(); errText != "" {
			rows = append(rows, ui.Text(errText, viewkit.PanelCaptionSize, ui.Regular, colors.Danger),
				ui.Button{Text: apptext.T("重试"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "auth-providers-retry", OnPress: a.loadAuthMethods})
		} else if len(rows) == 0 {
			rows = append(rows, ui.Text(apptext.T("当前 pi 未提供账号登录方式。请检查 pi 安装，或使用 API 密钥。"), viewkit.PanelCaptionSize, ui.Regular, colors.Muted))
		}
		return setGroup("账号登录", rows...)
	})
}

// entryDetail names the stored credential type and source without revealing
// the key. OAuth entries also show their expiry and refresh support.
func (a *app) authEntryDetail(e authEntry, now time.Time) string {
	parts := []string{entryDetail(e, now)}
	if info, ok := a.providerInfoOf(e.Provider); ok {
		parts = append(parts, authLabel(info))
		if info.Auth != "ready" {
			if reason := authReason(info.Reason); reason != "" {
				parts = append(parts, reason)
			}
		}
	}
	return strings.Join(parts, " · ")
}

func entryDetail(e authEntry, now time.Time) string {
	var parts []string
	if e.Type != "" {
		parts = append(parts, e.Type)
	}
	switch e.Source {
	case keyLiteral:
		parts = append(parts, apptext.T("写入文件"))
	case keyEnv:
		parts = append(parts, "$"+e.Name)
	case keyCommand:
		parts = append(parts, "!"+e.Name)
	}
	if e.Hint != "" {
		parts = append(parts, e.Hint)
	}
	if life := authLifetime(e.Expires, now); life != "" {
		parts = append(parts, life)
	}
	if e.Refreshable {
		parts = append(parts, apptext.T("可续期"))
	}
	if len(e.Env) > 0 {
		parts = append(parts, apptext.T("环境变量")+": "+strings.Join(e.Env, ", "))
	}
	if len(parts) == 0 {
		return apptext.T("文件里没有写这个条目的内容")
	}
	return strings.Join(parts, " · ")
}
