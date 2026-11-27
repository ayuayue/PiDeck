//go:build !js && !android && !ios

package workbench

// The settings window: a rail of sections beside the section's rows. Each
// row says what it is in a line and why in a quieter one, and the control
// sits at its end, so a section reads top to bottom.

import (
	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// defaultModelSettings selects the model a new local pi session starts with.
func (a *app) defaultModelSettings() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		a.settingsTick()
		providers := a.providers.Get()
		byID := make(map[string]providerInfo, len(providers))
		providerOptions := make([]ui.Option[string], 0, len(providers)+1)
		for _, provider := range providers {
			byID[provider.ID] = provider
			providerOptions = append(providerOptions, ui.Option[string]{Value: provider.ID, Label: provider.ID})
		}
		if a.defaultModel.Provider != "" {
			if _, found := byID[a.defaultModel.Provider]; !found {
				providerOptions = append(providerOptions, ui.Option[string]{Value: a.defaultModel.Provider, Label: a.defaultModel.Provider})
			}
		}
		var modelOptions []ui.Option[string]
		if provider, found := byID[a.defaultModel.Provider]; found {
			for _, model := range provider.Models {
				label := model.Name
				if label == "" {
					label = model.ID
				} else if label != model.ID {
					label += " · " + model.ID
				}
				modelOptions = append(modelOptions, ui.Option[string]{Value: model.ID, Label: label})
			}
		}
		if a.defaultModel.ID != "" {
			found := false
			for _, option := range modelOptions {
				if option.Value == a.defaultModel.ID {
					found = true
					break
				}
			}
			if !found {
				modelOptions = append(modelOptions, ui.Option[string]{Value: a.defaultModel.ID, Label: a.defaultModel.ID})
			}
		}
		return core.View{Style: core.Style{Width: core.Pct(100), MaxWidth: core.Pt(520), Gap: 7}, Children: []core.Node{
			ui.Select[string]{Options: providerOptions, Value: func() string { return a.defaultModel.Provider },
				Placeholder: apptext.T("跟随 pi 当前模型"), Label: apptext.T("供应商"), TestID: "default-model-provider", Searchable: true, SearchPlaceholder: apptext.T("搜索供应商"),
				OnClear: func() { a.setDefaultModel(modelChoice{}) },
				OnChange: func(provider string) {
					choice := modelChoice{Provider: provider}
					if provider == a.defaultModel.Provider {
						choice.ID = a.defaultModel.ID
					} else if info, found := byID[provider]; found && len(info.Models) > 0 {
						choice.ID = info.Models[0].ID
					}
					a.setDefaultModel(choice)
				},
				Style: core.Style{Width: core.Pct(100)}},
			ui.Select[string]{Options: modelOptions, Value: func() string { return a.defaultModel.ID },
				Placeholder: apptext.T("选择模型"), Label: apptext.T("模型"), TestID: "default-model-select", Searchable: true, SearchPlaceholder: apptext.T("搜索模型名称或 ID"),
				Disabled: func() bool { return a.defaultModel.Provider == "" },
				OnChange: func(model string) { a.setDefaultModel(modelChoice{Provider: a.defaultModel.Provider, ID: model}) },
				Style:    core.Style{Width: core.Pct(100)}},
		}}
	})
}

func (a *app) setDefaultModel(choice modelChoice) {
	a.defaultModel = choice
	a.updateGeneralSettings(func(c *config) { c.Model = choice })
}

// settingsGeneral groups preferences by the part of the app they affect.
func (a *app) settingsGeneral() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		a.settingsTick()
		return a.scrollStashFor("settings:general").Bind(cx, core.Scroll{TestID: "settings-page", Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: scrollbarGutter}}, Children: []core.Node{
				a.generalLayoutSettings(),
				a.generalSessionSettings(),
				setGroup("对话输入",
					setRow("快捷短语与回复规则", "管理输入框里的常用短语，以及回复结束后按条件出现的快捷发送按钮。",
						ui.Button{Text: apptext.T("管理…"), Size: ui.SizeSmall, Variant: ui.ButtonSecondary, TestID: "settings-reply-shortcuts", OnPress: a.openReplyShortcutSettings})),
				a.generalSidebarSettings(),
				a.generalNotificationSettings(),
				a.generalSoundSettings(),
				setGroup("安全与隐私",
					setRow("工具安全门", "仅对本机 pi 会话生效。标准会确认危险命令、保护敏感文件；严格还会将文件访问限制在工作目录内，并逐一确认写操作。",
						ui.Select[string]{Options: []ui.Option[string]{
							{Value: "off", Label: apptext.T("安全门关闭")},
							{Value: "standard", Label: apptext.T("标准")},
							{Value: "strict", Label: apptext.T("严格")},
						}, Value: a.securityLevelID, OnChange: a.setSecurityLevel,
							Label: apptext.T("工具安全门"), TestID: "security-level", Style: settingsSelectStyle()}),
					setDivider(),
					setRow("匿名使用统计", "启动时每天最多发一次心跳，带上版本、平台、功能开关与数量统计；不含项目路径、会话内容、文件名或凭据。",
						ui.Switch{Checked: func() bool { return telemetryEnabled(a.cfg) }, Label: apptext.T("匿名使用统计"), TestID: "telemetry-enabled",
							OnChange: func(on bool) { a.updateGeneralSettings(func(c *config) { c.TelemetryEnabled = &on }) }})),
			}},
		}})
	})
}
