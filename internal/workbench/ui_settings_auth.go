//go:build !js && !android && !ios

package workbench

import (
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) settingsCredentials() core.Node {
	return a.providerSettingsPage("settings-page", a.authGroup())
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
			controls = append(controls, ui.Button{Text: apptext.T("检测"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				TestID: "auth-check-" + e.Provider, OnPress: func() { a.authCheck(e.Provider) }})
			if e.Editable {
				controls = append(controls, ui.Button{Text: apptext.T("替换密钥"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
					TestID: "auth-replace-" + e.Provider, OnPress: func() { a.openAuthKey(e.Provider) }})
			}
			controls = append(controls, ui.Button{Text: apptext.T("删除"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				TestID: "auth-delete-" + e.Provider, OnPress: func() { a.dropAuthEntry(e.Provider) }})
			rows = append(rows, setRow(e.Provider, a.authEntryDetail(e, now),
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, AlignItems: core.AlignCenter, Gap: 6}, Children: controls}))
			if i < len(entries)-1 {
				rows = append(rows, setDivider())
			}
		}
		if len(entries) == 0 && errText == "" {
			rows = append(rows, setRow(apptext.T("还没有凭据"), apptext.T("通过 Pi 内置方式添加 API Key 或 OAuth 登录。"), nil))
		}
		if errText != "" {
			rows = append(rows, core.Text{Content: errText, Style: core.Style{FontSize: 10.5, Padding: core.Symmetric(3, 6)},
				StyleFunc: ui.Colored(colors.Danger)})
		}
		rows = append(rows,
			setDivider(),
			core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				ui.Button{Text: apptext.T("添加认证方式"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "auth-add",
					OnPress: a.openAuthMethods},
				ui.Button{Text: apptext.T("添加自定义密钥"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "auth-add-custom",
					OnPress: func() { a.openAuthKey("") }},
				ui.Button{Text: apptext.T("检测全部"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "auth-check-all",
					OnPress: a.refreshProviders},
				ui.Button{Text: apptext.T("编辑 auth.json"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.openPiConfigFile("auth.json") }},
			}})
		return setGroup("auth.json", rows...)
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
