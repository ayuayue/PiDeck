//go:build !js && !android && !ios

package workbench

// Two blocks of the provider dialog: the provider's own authentication
// state with the actions that change it, and the compatibility switches of
// the model being edited.

import (
	"strings"
	"time"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
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
				TestID: "provider-dialog-login", OnPress: func() { a.openProviderAuth(id) }},
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
	return compatibilityFields("compat-", a.modelCompatRev, func() map[string]bool { return a.modelCompat }, func(flag, mode string) {
		if a.modelCompat == nil {
			a.modelCompat = map[string]bool{}
		}
		if mode == "" {
			delete(a.modelCompat, flag)
		} else {
			a.modelCompat[flag] = mode == "on"
		}
		a.providerManagerState().modelDirty.Set(true)
	})
}
