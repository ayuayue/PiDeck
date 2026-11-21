//go:build !js && !android && !ios

package workbench

// The settings window: a rail of sections beside the section's rows. Each
// row says what it is in a line and why in a quieter one, and the control
// sits at its end, so a section reads top to bottom.

import (
	"sort"
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// settingsModels keeps the provider filter mounted while results change.
func (a *app) settingsModels() core.Node {
	colors := ui.ColorsOf(a.cx)
	return a.providerSettingsPage("settings-content",
		setGroup("供应商与认证",
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
				ui.Input{Value: a.providerQuery.Get, OnChange: a.providerQuery.Set,
					Style:       core.Style{FlexGrow: 1, MinWidth: core.Pt(110)},
					Placeholder: apptext.T("筛选供应商"), Label: apptext.T("筛选供应商"), TestID: "provider-filter"},
				ui.Button{Text: apptext.T("添加供应商"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "provider-add",
					OnPress: func() { a.openProviderDialog("") }},
			}},
			a.providerRows(),
			core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: []core.Node{
				ui.Button{Text: apptext.T("编辑 models.json"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
					OnPress: func() { a.openPiConfigFile("models.json") }},
				ui.Button{Text: apptext.T("检测全部"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: a.refreshProviders},
			}},
		),
		core.Text{Content: apptext.T("凭据由 pi 管理（~/.pi/agent/auth.json）。「登录…」在内置终端里跑 pi 自己的登录流程；改完点「检测全部」重新读状态。"),
			Style: core.Style{FontSize: 11, LineHeight: 17, Margin: core.Edges{Bottom: 12}}, StyleFunc: ui.Colored(colors.Muted)},
		a.favoriteModelSettings(), a.modelCatalogSettings(), a.balanceAccountsSettings(), a.toolModelsGroup(), a.tokenDanceGroup(),
	)
}

func (a *app) providerSettingsPage(testID string, content ...core.Node) core.Node {
	return core.Scroll{TestID: testID, Ref: a.settingsScroll, OnScroll: a.settingsScrolled, Style: ui.FillRest, Children: []core.Node{
		core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: 2}}, Children: content},
	}}
}

func (a *app) providerRows() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		// Redrawn when any setting changes: their values live in the config.
		a.settingsTick()
		colors := ui.ColorsOf(cx)
		query := strings.ToLower(strings.TrimSpace(a.providerQuery.Get()))
		list := make([]providerInfo, 0, len(a.providers.Get()))
		for _, p := range a.providers.Get() {
			if strings.Contains(strings.ToLower(p.ID+" "+p.API+" "+authLabel(p)), query) {
				list = append(list, p)
			}
		}
		rank := map[string]int{}
		for i, id := range a.providerOrder() {
			rank[id] = i
		}
		sort.SliceStable(list, func(i, j int) bool { return rank[list[i].ID] < rank[list[j].ID] })
		var rows []core.Node
		if len(list) == 0 && query != "" {
			rows = append(rows, ui.Text(apptext.T("没有匹配的供应商"), 12, ui.Regular, colors.Muted))
		} else if len(list) == 0 {
			rows = append(rows, setRow("没有读到供应商", "pi 的 models.json 里没有自定义供应商，或者还没探测完。", nil))
		}
		for i, p := range list {
			prov := p
			badge := func() core.Node {
				c := colors.Faint()
				switch prov.Auth {
				case "ready":
					c = colors.Up()
				case "not_ready":
					c = colors.Warn()
				case "invalid":
					c = colors.Danger()
				}
				return core.View{StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Padding: core.Symmetric(1, 7),
						CornerRadius: 10, Background: ui.Alpha(c, 0.10), BorderWidth: 1, BorderColor: ui.Alpha(c, 0.28)}
				}, Children: []core.Node{
					core.View{StyleFunc: func() core.Style {
						return core.Style{Width: core.Pt(5), Height: core.Pt(5), CornerRadius: 3, Background: c}
					}},
					ui.Text(authLabel(prov), 10.5, ui.Medium, func() core.Color { return c }),
				}}
			}
			// Where the key comes from, and why pi cannot resolve it when it
			// cannot: the two things a login fixes.
			credential := credentialLabel(prov.Credential)
			if prov.Credential.Detail != "" {
				credential += " · " + prov.Credential.Detail
			}
			if prov.Credential.Kind != "" && !prov.Credential.Ready {
				credential += " · " + apptext.T("未配置")
			}
			meta := apptext.T("%d 个模型", len(prov.Models))
			row := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10, MinHeight: core.Pt(44),
				Padding: core.Symmetric(4, 2)}, Children: []core.Node{
				core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 2}, Children: []core.Node{
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
						core.Text{Content: prov.ID, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 12.5, FontWeight: ui.Semibold},
							StyleFunc: ui.Colored(colors.Text)},
						ui.Text(meta, 10.5, ui.Regular, colors.Faint),
						ui.Text(prov.API, 10, ui.Regular, colors.Faint),
						core.Show{When: func() bool { return prov.Builtin }, Then: func(*core.Scope) core.Node {
							return ui.Text(apptext.T("内置"), 9.5, ui.Regular, colors.Faint)
						}},
					}},
					core.Text{Content: shorten(prov.BaseURL, 70), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
					core.Text{Content: credential, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5},
						StyleFunc: ui.Colored(func() core.Color {
							if prov.Credential.Kind != "" && !prov.Credential.Ready {
								return colors.Warn()
							}
							return colors.Faint()
						})},
					core.Show{When: func() bool { return prov.Reason != "" && prov.Auth != "ready" }, Then: func(*core.Scope) core.Node {
						return core.Text{Content: authReason(prov.Reason), Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5},
							StyleFunc: ui.Colored(colors.Danger)}
					}},
				}},
				badge(),
				hintOf(func() string { return apptext.T("登录") + " " + prov.ID }, ui.IconButton{Icon: lucide.LogIn, Label: apptext.T("登录") + " " + prov.ID, Size: 26, IconSize: 13,
					TestID: "provider-login-" + prov.ID, OnPress: func() { a.authLogin(prov.ID) }}),
				hintOf(func() string { return apptext.T("配置 ") + prov.ID }, ui.IconButton{Icon: lucide.Settings2, Label: apptext.T("配置 ") + prov.ID, Size: 26, IconSize: 13,
					TestID: "provider-configure-" + prov.ID, OnPress: func() { a.openProviderDialog(prov.ID) }}),
				arrowButton(lucide.ArrowUpToLine, "置顶供应商", func() { a.pinProvider(prov.ID) }),
				arrowButton(lucide.ChevronUp, "上移供应商", func() { a.moveProvider(prov.ID, -1) }),
				arrowButton(lucide.ChevronDown, "下移供应商", func() { a.moveProvider(prov.ID, 1) }),
			}}
			rows = append(rows, row)
			if i < len(list)-1 {
				rows = append(rows, setDivider())
			}
		}
		return core.Group(rows)
	})
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
