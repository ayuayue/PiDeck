//go:build !js && !android && !ios

package workbench

// The settings window: a rail of sections beside the section's rows. Each
// row says what it is in a line and why in a quieter one, and the control
// sits at its end, so a section reads top to bottom.

import (
	"fmt"
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) settingsCredentials() core.Node {
	return a.providerSettingsPage("settings-page", a.authGroup(), core.View{Style: core.Style{Direction: core.Row}, Children: []core.Node{
		ui.Button{Text: apptext.T("编辑 auth.json"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
			OnPress: func() { a.openPiConfigFile("auth.json") }},
	}})
}

// authGroup lists pi's credentials file with a way to check, replace, and
// remove each entry, and pi's own answer for the providers above it.
func (a *app) authGroup() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		entries := a.authEntries.Get()
		errText := a.authErr.Get()
		var rows []core.Node
		if summary := authSummary(a.providers.Get()); summary != "" {
			rows = append(rows, core.Text{Content: summary, MaxLines: 1, Style: core.Style{FontSize: 10.5},
				StyleFunc: ui.Colored(colors.Faint)}, setDivider())
		}
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
			rows = append(rows, setRow(e.Provider, entryDetail(e, time.Now()),
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
			core.Text{Content: apptext.T("pi 先看 auth.json，再看 models.json 的 apiKey，最后看环境变量。"),
				Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 10.5},
				StyleFunc: ui.Colored(colors.Faint)},
		}})
		return setGroup(apptext.T("pi 凭据"), rows...)
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
