//go:build !js && !android && !ios

package workbench

// Two blocks of the provider dialog: the provider's own authentication
// state with the actions that change it, and the compatibility switches of
// the model being edited.

import (
	"strings"
	"time"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// providerInfoOf is one provider as the list last read it.
func (a *app) providerInfoOf(id string) (providerInfo, bool) {
	for _, p := range a.providers.Get() {
		if p.ID == id {
			return p, true
		}
	}
	return providerInfo{ID: id}, false
}

// authEntryOf is one provider's entry in auth.json, when it has one.
func (a *app) authEntryOf(provider string) (authEntry, bool) {
	for _, e := range a.authEntries.Get() {
		if e.Provider == provider {
			return e, true
		}
	}
	return authEntry{}, false
}

// providerAuthBlock shows how pi authenticates this provider and offers
// the ways to change it: pi's own login in a terminal, a check, a sign-out,
// and the command to copy.
func (a *app) providerAuthBlock() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		id := a.providerID.Get()
		info, _ := a.providerInfoOf(id)
		tone := colors.Faint
		switch info.Auth {
		case "ready":
			tone = colors.Up
		case "not_ready":
			tone = colors.Warn
		case "invalid":
			tone = colors.Danger
		}
		var facts []string
		if info.AuthType != "" {
			facts = append(facts, info.AuthType)
		}
		if info.Credential.Kind != "" {
			fact := credentialLabel(info.Credential)
			if info.Credential.Detail != "" {
				fact += " · " + info.Credential.Detail
			}
			if !info.Credential.Ready {
				fact += " · " + apptext.T("未配置")
			}
			facts = append(facts, fact)
		}
		if entry, ok := a.authEntryOf(id); ok {
			if life := authLifetime(entry.Expires, time.Now()); life != "" {
				facts = append(facts, life)
			}
			if entry.Refreshable {
				facts = append(facts, apptext.T("可续期"))
			}
		}
		if reason := authReason(info.Reason); reason != "" && info.Auth != "ready" {
			facts = append(facts, reason)
		}
		detail := strings.Join(facts, " · ")
		if detail == "" {
			detail = apptext.T("pi 还没有回答这个供应商的凭据状态。")
		}
		_, stored := a.authEntryOf(id)
		var controls []core.Node
		controls = append(controls,
			ui.Button{Text: apptext.T("登录…"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall,
				TestID: "provider-dialog-login", OnPress: func() { a.authLogin(id) }},
			ui.Button{Text: apptext.T("检测"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
				TestID: "provider-dialog-check", OnPress: func() { a.authCheck(id) }})
		if stored {
			controls = append(controls, ui.Button{Text: apptext.T("登出"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				TestID: "provider-dialog-logout", OnPress: func() { a.dropAuthEntry(id) }})
		}
		controls = append(controls, ui.Button{Text: apptext.T("复制登录命令"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
			TestID: "provider-dialog-copy-login", OnPress: func() { a.copyText(loginCommand(info), apptext.T("登录命令")) }})
		return core.View{Style: core.Style{Gap: 6}, Children: []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				ui.Text(apptext.T("认证"), 10.5, ui.Medium, colors.Muted),
				infoDot(tone),
				ui.Text(authLabel(info), 11, ui.Medium, tone),
				core.Text{Content: detail, MaxLines: 2, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0),
					FontFamily: viewkit.MonoFont(), FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
			}},
			core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, AlignItems: core.AlignCenter, Gap: 6}, Children: controls},
		}}
	})
}

// infoDot is the state's coloured dot.
func infoDot(c func() core.Color) core.Node {
	return core.View{StyleFunc: func() core.Style {
		return core.Style{Width: core.Pt(5), Height: core.Pt(5), CornerRadius: 3, Background: c()}
	}}
}

// modelCompatEditor draws the compatibility switches of the model being
// edited: each one auto-detected, on, or off, as pi reads them.
func (a *app) modelCompatEditor() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		_ = a.modelCompatRev.Get()
		if !compatOpenAI(a.providerAPI.Get()) {
			return core.View{Style: core.Style{Gap: 3}, Children: []core.Node{
				ui.Text(apptext.T("兼容性"), 10.5, ui.Medium, colors.Muted),
				core.Text{Content: apptext.T("这些开关只对 OpenAI 兼容接口有用；这个供应商的 API 不用它们。"),
					Style: core.Style{FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
			}}
		}
		var rows []core.Node
		for _, flag := range compatFlags {
			flag := flag
			current := func() string {
				value, ok := a.modelCompat[flag]
				switch {
				case !ok:
					return ""
				case value:
					return "on"
				}
				return "off"
			}
			pick := func(mode string) {
				if a.modelCompat == nil {
					a.modelCompat = map[string]bool{}
				}
				switch mode {
				case "on":
					a.modelCompat[flag] = true
				case "off":
					a.modelCompat[flag] = false
				default:
					delete(a.modelCompat, flag)
				}
				a.modelCompatRev.Update(func(n int) int { return n + 1 })
			}
			rows = append(rows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8,
				MinHeight: core.Pt(24)}, Children: []core.Node{
				core.Text{Content: flag, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
					Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: viewkit.MonoFont(), FontSize: 9.5},
					StyleFunc: ui.Colored(colors.Muted)},
				choiceChips([]choice[string]{{"", apptext.T("自动")}, {"on", apptext.T("打开")}, {"off", apptext.T("关闭")}},
					current, pick),
			}})
		}
		hint := apptext.T("「自动」让 pi 按接口自己判断；这里只写这 7 个字段，其余保持原样。")
		if suggest := compatSuggestion(a.modelCompatSuggestion, a.modelCompat); suggest != "" {
			hint = apptext.T("官方目录建议 %s", suggest)
		}
		return core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				ui.Text(apptext.T("兼容性"), 10.5, ui.Medium, colors.Muted),
				core.Text{Content: apptext.T("compat"), Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5},
					StyleFunc: ui.Colored(colors.Faint)},
				ui.Icon(lucide.SlidersHorizontal, 11, colors.Faint),
			}},
			core.View{Style: core.Style{Gap: 1}, Children: rows},
			core.Text{Content: hint, MaxLines: 2, Style: core.Style{FontSize: 10, LineHeight: 15}, StyleFunc: ui.Colored(colors.Faint)},
		}}
	})
}
