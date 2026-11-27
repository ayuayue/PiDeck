//go:build !js && !android && !ios

package workbench

// The settings window: a rail of sections beside the section's rows. Each
// row says what it is in a line and why in a quieter one, and the control
// sits at its end, so a section reads top to bottom.

import (
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// settingsModels shows the providers and models declared in pi's models.json.
func (a *app) settingsModels() core.Node {
	return a.providerSettingsPage("settings-content",
		setGroup("models.json",
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
				ui.Input{Value: a.providerQuery.Get, OnChange: a.providerQuery.Set,
					Style:       core.Style{FlexGrow: 1, MinWidth: core.Pt(110)},
					Placeholder: apptext.T("筛选供应商"), Label: apptext.T("筛选供应商"), TestID: "provider-filter"},
				ui.Button{Text: apptext.T("添加供应商"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "provider-add",
					OnPress: func() { a.openProviderDialog("") }},
			}},
			a.configuredProviderCards(),
			setDivider(),
			setRow("models.json", "管理 providers 与模型条目。", ui.Button{Text: apptext.T("编辑 models.json"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				TestID: "models-json-edit", OnPress: func() { a.openPiConfigFile("models.json") }}),
		),
		a.favoriteModelSettings(),
		a.toolModelsGroup(),
		a.modelCatalogSettings(), a.balanceAccountsSettings(), a.tokenDanceGroup(),
	)
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
			favRows = append(favRows, core.Text{Content: apptext.T("在输入框的模型菜单里点星标收藏；收藏的模型排在最前，可在这里调顺序。"),
				Style: core.Style{FontSize: 11, LineHeight: 16, Padding: core.Symmetric(4, 2)}, StyleFunc: ui.Colored(colors.Faint)})
		}
		return setGroup("常用模型", core.View{Style: core.Style{Gap: 1}, Children: favRows})
	})
}

// toolModelsGroup gives each AI tool its own provider and model.
func (a *app) toolModelsGroup() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		_ = a.toolRev.Get()
		colors := ui.ColorsOf(cx)
		providers := a.providers.Get()
		var providerOpts []ui.Option[string]
		for _, p := range providers {
			if p.Configured {
				providerOpts = append(providerOpts, ui.Option[string]{Value: p.ID, Label: p.ID})
			}
		}
		tools := []struct{ ID, Name, Help string }{
			{"commit", "提交摘要", "按暂存改动生成一条提交说明，写进提交框。"},
			{"prompt", "提示词增强", "把输入框里的草稿改写得更清楚、更具体。"},
			{"predict", "输入预测", "在输入框里续写草稿的下一句。"},
			{"translate", "文本翻译", "翻译窗口使用的供应商与模型。"},
		}
		var rows []core.Node
		for i, tool := range tools {
			tool := tool
			cfg := a.cfg.ToolModels[tool.ID]
			var modelOpts []ui.Option[string]
			for _, p := range providers {
				if !p.Configured || p.ID != cfg.Provider {
					continue
				}
				for _, m := range p.Models {
					label := m.Name
					if label == "" {
						label = m.ID
					}
					modelOpts = append(modelOpts, ui.Option[string]{Value: m.ID, Label: label})
				}
			}
			control := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4}, Children: []core.Node{
				ui.Select[string]{Options: providerOpts, Value: func() string { return a.cfg.ToolModels[tool.ID].Provider },
					Placeholder: apptext.T("不启用"), OnClear: func() { a.setToolModel(tool.ID, "", "") },
					Label: apptext.T("供应商"), TestID: "tool-" + tool.ID + "-provider",
					Style: core.Style{Width: core.Pt(108)},
					OnChange: func(provider string) {
						model := ""
						for _, p := range providers {
							if p.Configured && p.ID == provider && len(p.Models) > 0 {
								model = p.Models[0].ID
								break
							}
						}
						a.setToolModel(tool.ID, provider, model)

						a.bumpSettings()
					}},
				ui.Select[string]{Options: modelOpts, Value: func() string { return a.cfg.ToolModels[tool.ID].Model },
					Placeholder: apptext.T("模型"), Disabled: func() bool { return a.cfg.ToolModels[tool.ID].Provider == "" },
					Label: apptext.T("模型"), TestID: "tool-" + tool.ID + "-model",
					Style: core.Style{Width: core.Pt(126)},
					OnChange: func(model string) {
						a.setToolModel(tool.ID, a.cfg.ToolModels[tool.ID].Provider, model)

						a.bumpSettings()
					}},
				hintOf(func() string { return apptext.T("清除") + " " + apptext.T(tool.Name) }, ui.IconButton{Icon: lucide.X, Label: apptext.T("清除") + " " + apptext.T(tool.Name), Size: 22, IconSize: 10,
					TestID: "tool-" + tool.ID + "-clear", Disabled: func() bool { return cfg.Provider == "" },
					OnPress: func() { a.setToolModel(tool.ID, "", "") }}),
			}}
			rows = append(rows, setRow(tool.Name, tool.Help, control))
			if i < len(tools)-1 {
				rows = append(rows, setDivider())
			}
		}
		if len(providerOpts) == 0 {
			rows = append(rows, core.Text{Content: apptext.T("还没有读到供应商；先配置供应商，或检查 pi 的 models.json。"),
				Style: core.Style{FontSize: 11, LineHeight: 16, Padding: core.Symmetric(4, 2)}, StyleFunc: ui.Colored(colors.Faint)})
		}
		rows = append(rows, setDivider(), setRow("提示词增强模板", "桌面与手机共用增强指令；可编辑或恢复默认。",
			ui.Button{Text: apptext.T("编辑模板…"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "settings-prompt-template", OnPress: a.openPromptTemplate}))
		return setGroup("工具模型", rows...)
	})
}
