//go:build !js && !android && !ios

package workbench

// The settings window: a rail of sections beside the section's rows. Each
// row says what it is in a line and why in a quieter one, and the control
// sits at its end, so a section reads top to bottom.

import (
	"strings"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// settingsModels follows the user's tasks instead of configuration file names.
func (a *app) settingsModels() core.Node {
	h := a.providerManagerState()
	return core.View{Style: ui.FillRest.Merge(core.Style{Gap: 10}), Children: []core.Node{
		ui.Tabs[string]{Variant: ui.TabsUnderline, Size: ui.SizeSmall, Label: apptext.T("模型与供应商"), TestID: "models-settings-tabs", Value: h.page.Get, OnChange: h.page.Set, Options: []ui.Option[string]{
			{Value: "providers", Label: apptext.T("供应商与模型"), TestID: "models-tab-providers"}, {Value: "tools", Label: apptext.T("默认与工具模型"), TestID: "models-tab-tools"}, {Value: "accounts", Label: apptext.T("账户与目录"), TestID: "models-tab-accounts"},
		}},
		core.Show{When: func() bool { return h.page.Get() == "providers" }, Then: func(cx *core.Scope) core.Node {
			return a.providerSettingsPage("settings-content",
				setGroup("供应商连接",
					core.Text{Content: apptext.T("添加供应商连接，然后管理该供应商的模型。每个供应商的用量查询可单独设置。"), Style: core.Style{FontSize: 11, Padding: core.Edges{Bottom: 12}}, StyleFunc: ui.Colored(ui.ColorsOf(cx).Muted)},
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
						ui.Input{Value: a.providerQuery.Get, OnChange: func(v string) { a.providerQuery.Set(v); h.providerLimit.Set(30) }, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(130)}, Placeholder: apptext.T("搜索供应商名称、协议或地址"), Label: apptext.T("筛选供应商"), TestID: "provider-filter"},
						ui.Button{Text: apptext.T("添加供应商"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "provider-add", OnPress: func() { a.openProviderDialog("") }},
					}}, a.providerBatchActions(), a.configuredProviderCards(),
					core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
						ui.Button{Text: apptext.T("管理 pi 登录与密钥"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "models-manage-credentials", OnPress: func() { a.openSettingsSection("credentials") }},
						ui.Button{Text: apptext.T("高级：编辑 models.json"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "models-json-edit", OnPress: func() { a.openPiConfigFile("models.json") }},
					}},
				),
			)
		}},
		core.Show{When: func() bool { return h.page.Get() == "tools" }, Then: func(cx *core.Scope) core.Node {
			return a.providerSettingsPage("settings-content", setGroup("新会话默认模型", core.Text{Content: apptext.T("用于新建 pi 会话；工具模型在下方单独指定。"), Style: core.Style{FontSize: 11, Padding: core.Edges{Bottom: 10}}, StyleFunc: ui.Colored(ui.ColorsOf(cx).Muted)}, a.defaultModelSettings()), a.favoriteModelSettings(), a.toolModelsGroup())
		}},
		core.Show{When: func() bool { return h.page.Get() == "accounts" }, Then: func(cx *core.Scope) core.Node {
			return a.providerSettingsPage("settings-content", setGroup("账户与模型目录", core.Text{Content: apptext.T("独立账户可使用不同的查询凭据；各供应商的余额或套餐查询请在“供应商与模型”中设置。"), Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(ui.ColorsOf(cx).Muted)}), a.balanceAccountsSettings(), a.tokenDanceGroup(), a.modelCatalogSettings())
		}},
	}}
}

func (a *app) providerSettingsPage(testID string, content ...core.Node) core.Node {
	return core.Scroll{TestID: testID, Style: ui.FillRest, Children: []core.Node{
		core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: scrollbarGutter}}, Children: content},
	}}
}

func (a *app) favoriteModelSettings() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		var favRows []core.Node
		favKeys := a.favModels.Get()
		for i, key := range favKeys {
			key := key
			provider, id, _ := strings.Cut(key, "/")
			last := i == len(favKeys)-1
			favRows = append(favRows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(32),
				Padding: core.Symmetric(2, 2)}, Children: []core.Node{
				ui.Icon(lucide.Star, 11, colors.Text),
				ui.Text(provider, 10, ui.Regular, colors.Faint),
				core.Text{Content: id, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
					Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12}, StyleFunc: ui.Colored(colors.Text)},
				arrowButton(lucide.ChevronUp, "上移", func() { a.moveFavourite(key, -1) }),
				arrowButton(lucide.ChevronDown, "下移", func() {
					if !last {
						a.moveFavourite(key, 1)
					}
				}),
				core.View{OnPress: func(core.PressEvent) {
					a.toggleFavModel(modelInfo{Provider: provider, ID: id})
				}, Role: core.RoleButton, Label: apptext.T("取消收藏 ") + id,
					StyleFunc: func() core.Style {
						return core.Style{Width: core.Pt(22), Height: core.Pt(22), CornerRadius: 5, AlignItems: core.AlignCenter,
							JustifyContent: core.JustifyCenter, Hover: &core.Style{Background: colors.Hover()}}
					},
					Children: []core.Node{ui.Icon(lucide.X, 11, colors.Faint)}},
			}})
		}
		if len(favRows) == 0 {
			favRows = append(favRows, core.Text{Content: apptext.T("在供应商的模型管理中点“收藏”，或在输入框的模型菜单里点星标；可在这里调整顺序。"),
				Style: core.Style{FontSize: 11, LineHeight: 16, Padding: core.Symmetric(4, 2)}, StyleFunc: ui.Colored(colors.Faint)})
		}
		return setGroup("常用模型", core.View{Style: core.Style{Gap: 1}, Children: favRows})
	})
}

// toolModelsGroup gives each tool a readable, searchable pair of controls.
func (a *app) toolModelsGroup() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		_ = a.toolRev.Get()
		colors := ui.ColorsOf(cx)
		providers := a.providers.Get()
		var providerOptions []ui.Option[string]
		for _, p := range providers {
			if len(p.Models) > 0 {
				providerOptions = append(providerOptions, ui.Option[string]{Value: p.ID, Label: p.ID})
			}
		}
		tools := []struct{ ID, Name, Help string }{
			{"commit", "提交摘要", "按暂存改动生成一条提交说明，写进提交框。"}, {"prompt", "提示词增强", "把输入框里的草稿改写得更清楚、更具体。"}, {"predict", "输入预测", "在输入框里续写草稿的下一句。"}, {"translate", "文本翻译", "翻译窗口使用的供应商与模型。"},
		}
		var rows []core.Node
		for _, entry := range tools {
			tool := entry
			cfg := a.cfg.ToolModels[tool.ID]
			var modelOptions []ui.Option[string]
			for _, p := range providers {
				if p.ID == cfg.Provider {
					for _, m := range p.Models {
						label := m.ID
						if m.Name != "" && m.Name != m.ID {
							label = m.Name + " · " + m.ID
						}
						modelOptions = append(modelOptions, ui.Option[string]{Value: m.ID, Label: label})
					}
				}
			}
			rows = append(rows, core.View{Style: core.Style{Gap: 8, Padding: core.Symmetric(12, 0)}, Children: []core.Node{
				ui.Text(apptext.T(tool.Name), 12, ui.Medium, colors.Text),
				core.Text{Content: apptext.T(tool.Help), Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
				ui.Select[string]{Options: providerOptions, Value: func() string { return a.cfg.ToolModels[tool.ID].Provider }, Placeholder: apptext.T("不启用：选择供应商后开启"), Label: apptext.T("供应商"), TestID: "tool-" + tool.ID + "-provider", Searchable: true, SearchPlaceholder: apptext.T("搜索供应商"), Style: core.Style{Width: core.Pct(100)}, OnClear: func() { a.setToolModel(tool.ID, "", ""); a.bumpSettings() }, OnChange: func(provider string) {
					model := ""
					for _, p := range providers {
						if p.ID == provider && len(p.Models) > 0 {
							model = p.Models[0].ID
							break
						}
					}
					a.setToolModel(tool.ID, provider, model)
					a.bumpSettings()
				}},
				ui.Select[string]{Options: modelOptions, Value: func() string { return a.cfg.ToolModels[tool.ID].Model }, Placeholder: apptext.T("选择模型"), Label: apptext.T("模型"), TestID: "tool-" + tool.ID + "-model", Searchable: true, SearchPlaceholder: apptext.T("搜索模型名称或 ID"), Style: core.Style{Width: core.Pct(100)}, Disabled: func() bool { return a.cfg.ToolModels[tool.ID].Provider == "" }, OnChange: func(model string) {
					a.setToolModel(tool.ID, a.cfg.ToolModels[tool.ID].Provider, model)
					a.bumpSettings()
				}},
				ui.Button{Text: apptext.T("停用此工具"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "tool-" + tool.ID + "-clear", Disabled: func() bool { return cfg.Provider == "" }, OnPress: func() { a.setToolModel(tool.ID, "", ""); a.bumpSettings() }},
			}}, setDivider())
		}
		if len(providerOptions) == 0 {
			rows = append(rows, ui.Text(apptext.T("请先添加供应商和模型，再为工具选择模型。"), 11, ui.Regular, colors.Muted))
		}
		rows = append(rows, setRow("提示词增强模板", "桌面与手机共用增强指令；可编辑或恢复默认。", ui.Button{Text: apptext.T("编辑模板…"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "settings-prompt-template", OnPress: a.openPromptTemplate}))
		return setGroup("工具模型", rows...)
	})
}
