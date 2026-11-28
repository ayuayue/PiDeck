//go:build !js && !android && !ios

package workbench

import (
	"strings"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) providerModelsPanel(cx *core.Scope) core.Node {
	h := a.providerManagerState()
	colors := ui.ColorsOf(cx)
	if !h.configured {
		return core.View{Style: core.Style{Gap: 10}, Children: []core.Node{ui.Text(apptext.T("先保存连接设置，再添加或修改模型。"), 12, ui.Regular, colors.Muted), ui.Button{Text: apptext.T("前往连接设置"), TestID: "provider-models-setup", OnPress: func() { h.tab.Set("connection") }}}}
	}
	return core.Dynamic(func(cx *core.Scope) core.Node {
		_ = a.providerModelsRev.Get()
		if h.modelAdvancedOpen.Get() {
			return a.providerModelAdvancedPanel(cx)
		}
		if h.modelForm.Get() {
			return a.providerModelForm(cx)
		}
		id := a.providerID.Get()
		provider := providerInfo{ID: id, Configured: true, Models: append([]modelConfig(nil), a.providerModels...)}
		return core.View{Style: core.Style{Gap: 12}, Children: []core.Node{
			core.Text{Content: apptext.T("模型 ID 必须与供应商实际提供的 ID 一致。获取列表后勾选添加，也可以手动填写。"), Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
			core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
				ui.Button{Text: apptext.T("获取模型列表"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "provider-fetch-models-" + id, OnPress: func() { a.providerCardOpen.Set(id); a.fetchConfiguredProviderModels(id) }, Disabled: a.providerFetchBusy.Get},
				ui.Button{Text: apptext.T("手动添加模型"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "provider-model-add-manual-" + id, OnPress: func() { a.resetModelForm(); h.modelForm.Set(true) }},
				ui.Button{Text: apptext.T("按名称排序"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "provider-model-sort-" + id, Disabled: func() bool { return a.providerModelWriteBusy.Get() || len(a.providerModels) < 2 }, OnPress: func() { a.sortConfiguredProviderModels(id) }},
			}},
			core.Show{When: func() bool { return a.providerTest.Get() != "" }, Then: func(cx *core.Scope) core.Node {
				return core.Text{ContentFunc: a.providerTest.Get, TestID: "provider-model-test-result", Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)}
			}},
			core.Text{Content: apptext.T("测试模型会发送一次最小请求，可能产生少量费用。"), Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Muted)},
			core.Show{When: func() bool { return a.providerFetchBusy.Get() || a.providerFetchError.Get() != "" }, Then: func(cx *core.Scope) core.Node {
				return core.Text{ContentFunc: func() string {
					if a.providerFetchBusy.Get() {
						return apptext.T("正在获取模型列表…")
					}
					return a.providerFetchError.Get()
				}, TestID: "provider-fetch-status", Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)}
			}},
			core.Dynamic(func(cx *core.Scope) core.Node {
				if fetched := a.providerFetchedModels.Get(); len(fetched) > 0 {
					return a.fetchedModelPicker(provider, fetched)
				}
				return core.View{}
			}),
			ui.Input{Value: h.modelQuery.Get, OnChange: func(s string) { h.modelQuery.Set(s); h.modelLimit.Set(30) }, Label: apptext.T("搜索已配置模型"), Placeholder: apptext.T("搜索模型名称或 ID"), TestID: "provider-model-filter"},
			a.modelBatchActions(provider),
			a.providerManagedModelList(provider),
		}}
	})
}

func (a *app) providerManagedModelList(provider providerInfo) core.Node {
	h := a.providerManagerState()
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		query := strings.ToLower(strings.TrimSpace(h.modelQuery.Get()))
		limit := h.modelLimit.Get()
		fav := a.favModels.Get()
		a.settingsTick()
		var rows []core.Node
		count := 0
		for _, model := range provider.Models {
			m := model
			if query != "" && !strings.Contains(strings.ToLower(m.ID+" "+m.Name), query) {
				continue
			}
			count++
			if count > limit {
				continue
			}
			name := m.Name
			if name == "" {
				name = m.ID
			}
			key := provider.ID + "/" + m.ID
			starred := false
			for _, v := range fav {
				if v == key {
					starred = true
					break
				}
			}
			favLabel := apptext.T("收藏")
			if starred {
				favLabel = apptext.T("取消收藏")
			}
			meta := m.ID
			if m.ContextWindow > 0 {
				meta += " · " + viewkit.Tokens(m.ContextWindow) + apptext.T("上下文")
			}
			if m.Reasoning {
				meta += " · " + apptext.T("推理")
			}
			if m.Images {
				meta += " · " + apptext.T("图片")
			}
			hideLabel := apptext.T("隐藏模型")
			if a.modelHidden(provider.ID, m.ID) {
				hideLabel = apptext.T("恢复显示")
			}
			rows = append(rows, core.View{TestID: "provider-model-row-" + modelTestToken(m.ID), Style: core.Style{Gap: 7, Padding: core.Symmetric(10, 0), Borders: core.Edges{Bottom: 1}}, StyleFunc: func() core.Style { return core.Style{BorderColor: colors.Border()} }, Children: []core.Node{
				ui.Checkbox{Text: name, TestID: "provider-model-select-" + modelTestToken(m.ID), Checked: func() bool { return h.selectedModels.Get()[m.ID] }, OnChange: func(on bool) { selectionSet(h.selectedModels, m.ID, on) }},
				core.Text{Content: meta, Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Muted)},
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6, AlignItems: core.AlignCenter}, Children: []core.Node{
					ui.Button{Text: apptext.T("编辑"), Size: ui.SizeSmall, Variant: ui.ButtonSecondary, TestID: "provider-model-" + m.ID, OnPress: func() { a.editProviderModel(m) }},
					ui.Button{Text: apptext.T("测试模型"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "provider-model-test-" + modelTestToken(m.ID), Disabled: h.testBusy.Get, OnPress: func() { a.testManagedProviderModel(m.ID) }},
					ui.Button{Text: favLabel, Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "provider-model-favorite-" + modelTestToken(m.ID), OnPress: func() { a.toggleFavModel(modelInfo{Provider: provider.ID, ID: m.ID, Name: m.Name}) }},
					ui.Button{Text: apptext.T("设为默认"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "provider-model-default-" + modelTestToken(m.ID), Disabled: func() bool { return a.defaultModel.Provider == provider.ID && a.defaultModel.ID == m.ID }, OnPress: func() {
						a.setDefaultModel(modelChoice{Provider: provider.ID, ID: m.ID})
						a.toast(ui.ToastSuccess, "默认模型已更新", "新建会话将使用这个模型。")
					}},
					ui.Button{Text: apptext.T("更多"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "provider-model-more-" + modelTestToken(m.ID), OnPress: func() {
						if h.modelActions.GetUntracked() == m.ID {
							h.modelActions.Set("")
						} else {
							h.modelActions.Set(m.ID)
						}
					}},
				}},
				core.Show{When: func() bool { return h.modelActions.Get() == m.ID }, Then: func(cx *core.Scope) core.Node {
					return core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6, AlignItems: core.AlignCenter}, Children: []core.Node{
						ui.IconButton{Icon: lucide.ChevronUp, Label: apptext.T("上移模型"), Size: 24, IconSize: 12, TestID: "provider-model-order-up-" + provider.ID + "-" + modelTestToken(m.ID), Disabled: a.providerModelWriteBusy.Get, OnPress: func() { a.moveConfiguredProviderModel(provider.ID, m.ID, -1) }},
						ui.IconButton{Icon: lucide.ChevronDown, Label: apptext.T("下移模型"), Size: 24, IconSize: 12, TestID: "provider-model-order-down-" + provider.ID + "-" + modelTestToken(m.ID), Disabled: a.providerModelWriteBusy.Get, OnPress: func() { a.moveConfiguredProviderModel(provider.ID, m.ID, 1) }},
						ui.Button{Text: apptext.T("高级设置"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "provider-model-advanced-" + modelTestToken(m.ID), OnPress: func() { a.openProviderModelAdvanced(m.ID) }},
						ui.Button{Text: hideLabel, Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "provider-model-hidden-" + modelTestToken(m.ID), OnPress: func() { a.toggleModelHidden(provider.ID, m.ID) }},
						ui.Button{Text: apptext.T("恢复默认"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "provider-model-reset-" + modelTestToken(m.ID), OnPress: func() { a.resetManagedModel(m.ID) }},
						ui.Button{Text: apptext.T("删除"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "provider-model-remove-" + m.ID, Disabled: h.busy.Get, OnPress: func() { a.removeProviderModel(m.ID) }},
					}}
				}},
			}})
		}
		if count == 0 {
			message := apptext.T("还没有模型。请获取列表或手动添加第一个模型。")
			if query != "" {
				message = apptext.T("没有匹配的模型")
			}
			rows = append(rows, ui.Text(message, 11, ui.Regular, colors.Muted))
		}
		if count > limit {
			rows = append(rows, ui.Button{Text: apptext.T("加载更多（剩余 %d 个）", count-limit), Variant: ui.ButtonGhost, TestID: "provider-model-load-more", OnPress: func() { h.modelLimit.Update(func(n int) int { return n + 30 }) }})
		}
		return core.View{Style: core.Style{Gap: 2}, Children: rows}
	})
}

func (a *app) providerModelForm(cx *core.Scope) core.Node {
	h := a.providerManagerState()
	colors := ui.ColorsOf(cx)
	advanced := core.NewSignal(cx, false)
	field := func(label, help, id string, value *core.Signal[string]) core.Node {
		return providerFormField(label, help, ui.Input{Value: value.Get, OnChange: func(v string) { value.Set(v); h.modelDirty.Set(true) }, Label: apptext.T(label), TestID: id, Disabled: h.busy.Get})
	}
	title := apptext.T("添加模型")
	if a.providerModelEditing.GetUntracked() != "" {
		title = apptext.T("编辑模型")
	}
	return core.View{Style: core.Style{Gap: 12}, Children: []core.Node{
		ui.Text(title, 14, ui.Semibold, colors.Text),
		field("模型 ID（必填）", "从供应商模型列表或 API 文档复制，区分大小写。", "provider-model-id", a.providerModelID),
		field("显示名称（可选）", "仅用于界面显示；留空时显示模型 ID。", "provider-model-name", a.providerModelName),
		field("上下文窗口（tokens）", "模型一次能处理的总 token 数；留空沿用默认值。", "provider-model-context", a.providerModelContext),
		field("最大输出（tokens）", "一次回复的最大 token 数；不能超过上下文窗口。", "provider-model-max", a.providerModelMax),
		ui.Checkbox{Text: apptext.T("支持推理 / 思考"), TestID: "provider-model-reasoning", Checked: a.providerModelReasoning.Get, OnChange: func(v bool) { a.providerModelReasoning.Set(v); h.modelDirty.Set(true) }},
		ui.Checkbox{Text: apptext.T("支持图片输入"), TestID: "provider-model-images", Checked: a.providerModelImages.Get, OnChange: func(v bool) { a.providerModelImages.Set(v); h.modelDirty.Set(true) }},
		ui.Checkbox{Text: apptext.T("显示价格与兼容性选项"), TestID: "provider-model-advanced", Checked: advanced.Get, OnChange: advanced.Set},
		core.Show{When: advanced.Get, Then: func(cx *core.Scope) core.Node {
			return core.View{Style: core.Style{Gap: 12}, Children: []core.Node{
				ui.Text(apptext.T("价格仅供费用估算，单位为美元 / 百万 tokens；留空表示未配置。"), 11, ui.Regular, colors.Muted),
				field("输入价格", "", "provider-model-cost-in", a.providerModelCostIn), field("输出价格", "", "provider-model-cost-out", a.providerModelCostOut), field("缓存读取价格", "", "provider-model-cost-read", a.providerModelCostRead), field("缓存写入价格", "", "provider-model-cost-write", a.providerModelCostWrite), a.modelCompatEditor(),
			}}
		}},
	}}
}
