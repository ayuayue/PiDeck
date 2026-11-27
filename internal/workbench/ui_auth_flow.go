//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) authFlowDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		// Progress events must not remount a partially typed authorization code.
		prompt := core.NewMemo(cx, func() *authPrompt { return a.authUI.Flow.Get().Prompt })
		return ui.Dialog{
			Open: func() bool { return a.authUI.Flow.Get().Open },
			OnOpenChange: func(open bool, _ base.Reason) {
				if !open {
					a.closeAuthFlow()
				}
			},
			TitleFunc: func() string { return apptext.T("登录 %s", a.authProviderName(a.authUI.Flow.Get().Provider)) },
			TestID:    "auth-flow-dialog", Style: core.Style{Width: a.dialogWidth(), MaxWidth: core.Pt(640), MaxHeight: core.Pt(660)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 12}, Children: []core.Node{
				core.Dynamic(func(*core.Scope) core.Node {
					view := a.authUI.Flow.Get()
					var nodes []core.Node
					if view.Phase == "running" {
						nodes = append(nodes, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
							ui.Spinner{Size: 14}, ui.Text(apptext.T("等待完成授权…"), viewkit.PanelTextSize, ui.Medium, colors.Text),
						}})
					}
					if view.Phase == "failed" {
						nodes = append(nodes, ui.Text(apptext.T("登录未完成"), viewkit.PanelTextSize, ui.Medium, colors.Danger))
					}
					if view.Message != "" {
						ink := colors.Muted
						if view.Phase == "failed" {
							ink = colors.Danger
						}
						nodes = append(nodes, core.Text{Content: view.Message, TestID: "auth-flow-message", Style: core.Style{FontSize: viewkit.PanelTextSize, LineHeight: 19}, StyleFunc: ui.Colored(ink)})
					}
					if view.Phase == "running" && view.URL != "" {
						if view.OpenFailed {
							nodes = append(nodes, ui.Text(apptext.T("未能打开浏览器，请点击打开授权页，或复制链接手动打开。"), viewkit.PanelCaptionSize, ui.Regular, colors.Danger))
						}
						nodes = append(nodes, core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
							ui.Button{Text: apptext.T("打开授权页"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "auth-flow-open-url", OnPress: func() { a.openAuthURL(view.URL) }},
							ui.Button{Text: apptext.T("复制链接"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "auth-flow-copy-url", OnPress: func() { a.cx.SetClipboard(view.URL) }},
						}})
						if view.Code != "" {
							nodes = append(nodes, ui.Text(apptext.T("在授权页输入设备码"), viewkit.PanelCaptionSize, ui.Regular, colors.Muted),
								core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
									core.Text{Content: view.Code, TestID: "auth-flow-device-code", Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: viewkit.PanelTextSize}, StyleFunc: ui.Colored(colors.Text)},
									ui.Button{Text: apptext.T("复制设备码"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "auth-flow-copy-code", OnPress: func() { a.cx.SetClipboard(view.Code) }},
								}})
						}
					}
					// Keep provider-supplied auxiliary links available without opening
					// them automatically; they may be docs rather than sign-in pages.
					if view.Phase == "running" {
						for _, event := range view.Events {
							for _, link := range event.Links {
								target := safeAuthURL(link.URL)
								if target == "" {
									continue
								}
								label := link.Label
								if label == "" {
									label = apptext.T("打开链接")
								}
								nodes = append(nodes, ui.Button{Text: label, Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.openAuthURL(target) }})
							}
						}
					}
					return core.View{Style: core.Style{Gap: 10}, Children: nodes}
				}),
				core.Dynamic(func(*core.Scope) core.Node {
					pending := prompt.Get()
					if pending == nil {
						return core.Group(nil)
					}
					nodes := []core.Node{ui.Text(pending.Message, viewkit.PanelTextSize, ui.Medium, colors.Text)}
					if pending.Kind == "select" {
						for _, option := range pending.Options {
							option := option
							nodes = append(nodes, ui.Button{Text: option.Label, Variant: ui.ButtonSecondary, TestID: "auth-flow-option-" + option.ID, OnPress: func() { a.answerAuthPrompt(option.ID) }})
							if option.Description != "" {
								nodes = append(nodes, ui.Text(option.Description, viewkit.PanelCaptionSize, ui.Regular, colors.Muted))
							}
						}
					} else {
						nodes = append(nodes, ui.Input{Value: a.authUI.Answer.Get, OnChange: a.authUI.Answer.Set, Placeholder: pending.Placeholder,
							Masked: pending.Kind == "secret", Label: pending.Message, TestID: "auth-flow-answer", MaxLength: 16384,
							OnSubmit: func(value string) { a.answerAuthPrompt(value) }},
							ui.Button{Text: apptext.T("继续"), Variant: ui.ButtonPrimary, TestID: "auth-flow-submit",
								Disabled: func() bool { return pending.Kind != "text" && a.authUI.Answer.Get() == "" }, OnPress: func() { a.answerAuthPrompt(a.authUI.Answer.GetUntracked()) }})
					}
					return core.View{TestID: "auth-flow-prompt", Style: core.Style{Gap: 8}, Children: nodes}
				}),
				ui.Text(apptext.T("认证使用 Agent 代理。网络不通时，可取消并在本页调整代理后重试。"), viewkit.PanelCaptionSize, ui.Regular, colors.Muted),
			}}},
			Footer: []core.Node{
				core.Show{When: func() bool { return a.authUI.Flow.Get().Phase == "failed" }, Then: func(*core.Scope) core.Node {
					return ui.Button{Text: apptext.T("重试"), Variant: ui.ButtonPrimary, TestID: "auth-flow-retry", OnPress: func() {
						view := a.authUI.Flow.GetUntracked()
						a.authLoginMode(view.Provider, view.APIKey, view.NoBrowser)
					}}
				}},
				ui.Button{TextFunc: func() string {
					if a.authUI.Flow.Get().Phase == "running" {
						return apptext.T("取消登录")
					}
					return apptext.T("完成")
				},
					Variant: ui.ButtonSecondary, TestID: "auth-flow-close", OnPress: a.closeAuthFlow},
			},
		}
	})
}
