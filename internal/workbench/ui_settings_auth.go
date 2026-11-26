//go:build !js && !android && !ios

package workbench

// The settings window: a rail of sections beside the section's rows. Each
// row says what it is in a line and why in a quieter one, and the control
// sits at its end, so a section reads top to bottom.

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) settingsCredentials() core.Node {
	return a.providerSettingsPage("settings-page", a.authEffectiveGroup(), a.authGroup())
}

// authEffectiveGroup answers the question that matters before editing a file:
// which credential pi will use for each configured provider, and what can fix
// it when that credential is not ready.
func (a *app) authEffectiveGroup() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		a.settingsTick()
		colors := ui.ColorsOf(cx)
		all := a.providers.Get()
		list := make([]providerInfo, 0, len(all))
		for _, p := range all {
			_, stored := a.authEntryOf(p.ID)
			if !p.Configured && p.Credential.Kind == "" && !stored {
				continue
			}
			list = append(list, p)
		}
		rank := map[string]int{}
		for i, id := range a.providerOrder() {
			rank[id] = i
		}
		sort.SliceStable(list, func(i, j int) bool { return rank[list[i].ID] < rank[list[j].ID] })

		rows := []core.Node{}
		if summary := authSummary(list); summary != "" {
			rows = append(rows, setRow("供应商", summary, ui.Button{Text: apptext.T("检测全部"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				TestID: "auth-overview-check-all", OnPress: a.refreshProviders}), setDivider())
		}
		for i, p := range list {
			prov := p
			tone := colors.Faint
			switch prov.Auth {
			case "ready":
				tone = colors.Up
			case "not_ready":
				tone = colors.Warn
			case "invalid":
				tone = colors.Danger
			}
			detail := credentialLabel(prov.Credential)
			if prov.Credential.Detail != "" {
				detail += " · " + prov.Credential.Detail
			}
			if prov.Credential.Kind != "" && !prov.Credential.Ready {
				detail += " · " + apptext.T("未配置")
			}
			if reason := authReason(prov.Reason); reason != "" && prov.Auth != "ready" {
				detail += " · " + reason
			}
			controls := []core.Node{core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5}, Children: []core.Node{
				infoDot(tone), ui.Text(authLabel(prov), 10.5, ui.Medium, tone),
			}}}
			if prov.Auth != "ready" {
				controls = append(controls, ui.Button{Text: apptext.T("登录…"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall,
					TestID: "auth-overview-login-" + prov.ID, OnPress: func() { a.authLogin(prov.ID) }})
				if prov.Credential.Kind == "" || prov.Credential.Kind == credentialModels {
					controls = append(controls, ui.Button{Text: apptext.T("添加密钥…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						TestID: "auth-overview-add-" + prov.ID, OnPress: func() { a.openAuthKey(prov.ID) }})
				}
			}
			controls = append(controls, ui.Button{Text: apptext.T("检测"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				TestID: "auth-overview-check-" + prov.ID, OnPress: func() { a.authCheck(prov.ID) }})
			rows = append(rows, setRow(prov.ID, detail, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: controls}))
			if i < len(list)-1 {
				rows = append(rows, setDivider())
			}
		}
		if len(list) == 0 {
			rows = append(rows, setRow(apptext.T("还没有凭据"), apptext.T("没有可用的凭据"), ui.Button{Text: apptext.T("添加密钥…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
				TestID: "auth-overview-add", OnPress: func() { a.openAuthKey("") }}))
		}
		return setGroup("认证", rows...)
	})
}

// authGroup lists pi's credentials file with a way to check, replace, and
// remove each entry. The effective provider view above owns the current
// readiness summary; this block stays focused on auth.json entries.
func (a *app) authGroup() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		entries := a.authEntries.Get()
		errText := a.authErr.Get()
		now := cx.Now()
		var rows []core.Node
		for _, e := range entries {
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
			rows = append(rows, setRow(e.Provider, entryDetail(e, now),
				core.View{Style: core.Style{Direction: core.Row, Gap: 6}, Children: controls}))
			rows = append(rows, setDivider())
		}
		if len(entries) == 0 && errText == "" {
			rows = append(rows, setRow(apptext.T("还没有凭据"), apptext.T("在终端里登录 pi，或在这里添加一个 API key。"), nil), setDivider())
		}
		if errText != "" {
			rows = append(rows, core.Text{Content: errText, Style: core.Style{FontSize: 10.5, Padding: core.Symmetric(3, 6)},
				StyleFunc: ui.Colored(colors.Danger)})
		}
		rows = append(rows, core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, AlignItems: core.AlignCenter, Gap: 6,
			Margin: core.Edges{Top: 2}}, Children: []core.Node{
			ui.Button{Text: apptext.T("添加密钥…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "auth-add",
				OnPress: func() { a.openAuthKey("") }},
			ui.Button{Text: apptext.T("检测全部"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "auth-check-all",
				OnPress: a.refreshProviders},
			ui.Button{Text: apptext.T("编辑 auth.json"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				OnPress: func() { a.openPiConfigFile("auth.json") }},
			core.Text{Content: apptext.T("pi 先看 auth.json，再看 models.json 的 apiKey，最后看环境变量。"),
				Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 10.5},
				StyleFunc: ui.Colored(colors.Faint)},
		}})
		return setGroup("pi 凭据", rows...)
	})
}

// authSummary counts the providers by pi's verdict, so the section opens
// with the state of the whole setup.
func authSummary(list []providerInfo) string {
	if len(list) == 0 {
		return ""
	}
	counts := map[string]int{}
	for _, p := range list {
		counts[p.Auth]++
	}
	parts := []string{fmt.Sprintf("%d", len(list))}
	if n := counts["ready"]; n > 0 {
		parts = append(parts, fmt.Sprintf("%s %d", apptext.T("已就绪"), n))
	}
	if n := counts["not_ready"]; n > 0 {
		parts = append(parts, fmt.Sprintf("%s %d", apptext.T("未配置"), n))
	}
	if n := counts["invalid"]; n > 0 {
		parts = append(parts, fmt.Sprintf("%s %d", apptext.T("已失效"), n))
	}
	return apptext.T("供应商") + " " + strings.Join(parts, " · ")
}

// entryDetail is one credential in a line: its kind, where the value comes
// from, and how long an OAuth token lasts.
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
