//go:build !js && !android && !ios

package workbench

// The dialog that replaces one provider's api key in pi's auth.json.

import (
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// authKeyDialog asks for a provider and its key.
func (a *app) authKeyDialog() core.Node {
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
		title := apptext.T("添加密钥")
		if strings.TrimSpace(a.authKeyProvider.GetUntracked()) != "" {
			title = apptext.T("替换密钥")
		}
		return ui.Dialog{
			Open:         a.authKeyOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.authKeyOpen.Set(open) },
			Title:        title,
			Description:  apptext.T("只改这个供应商的 type 与 key；auth.json 里的其他字段保持原样。"),
			TestID:       "auth-key",
			Style:        core.Style{Width: core.Pt(480)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 10}, Children: []core.Node{
				field(a.authKeyProvider, apptext.T("供应商"), "anthropic", "auth-provider"),
				field(a.authKeyText, apptext.T("API key"), "sk-…", "auth-key-input"),
				core.Text{Content: apptext.T("保存后重启 Agent 生效。"), Style: core.Style{FontSize: 10.5},
					StyleFunc: ui.Colored(colors.Faint)},
			}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.authKeyOpen.Set(false) }},
				ui.Button{Text: apptext.T("保存"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "auth-key-save",
					OnPress: a.saveAuthKey},
			},
		}
	})
}
