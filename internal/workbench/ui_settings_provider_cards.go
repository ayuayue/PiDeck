//go:build !js && !android && !ios

package workbench

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) configuredProviderCards() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		a.settingsTick()
		colors := ui.ColorsOf(cx)
		query := strings.ToLower(strings.TrimSpace(a.providerQuery.Get()))
		list := make([]providerInfo, 0, len(a.providers.Get()))
		for _, provider := range a.providers.Get() {
			if !provider.Configured {
				continue
			}
			if query != "" && !strings.Contains(strings.ToLower(provider.ID+" "+provider.API+" "+provider.BaseURL), query) {
				continue
			}
			list = append(list, provider)
		}
		rank := map[string]int{}
		for i, id := range a.providerOrder() {
			rank[id] = i
		}
		sort.SliceStable(list, func(i, j int) bool { return rank[list[i].ID] < rank[list[j].ID] })
		if len(list) == 0 {
			message := apptext.T("pi 的 models.json 里还没有供应商。添加供应商后，可在卡片内管理模型。")
			if query != "" {
				message = apptext.T("没有匹配的供应商")
			}
			return core.Text{Content: message, Style: core.Style{FontSize: 11, LineHeight: 16, Padding: core.Symmetric(8, 3)},
				StyleFunc: ui.Colored(colors.Muted)}
		}
		var rows []core.Node
		for i, provider := range list {
			provider := provider
			index := i
			isOpen := func() bool { return a.providerCardOpen.Get() == provider.ID }
			label := provider.ID + " · " + apptext.T("%d 个模型", len(provider.Models))
			name := core.View{OnPress: func(core.PressEvent) {
				a.toggleProviderCard(provider.ID)
			}, Role: core.RoleButton, Label: label,
				Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)},
				Children: []core.Node{
					viewkit.BrandName(colors, provider.ID, 15, core.Text{Content: provider.ID,
						Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 12.5, FontWeight: ui.Semibold}, StyleFunc: ui.Colored(colors.Text)}),
					ui.Text(apptext.T("%d 个模型", len(provider.Models)), 10.5, ui.Regular, colors.Muted),
				}}
			header := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, MinHeight: core.Pt(44), Padding: core.Symmetric(3, 2)}, Children: []core.Node{
				ui.IconButton{Icon: func() *core.SVG {
					if isOpen() {
						return lucide.ChevronDown()
					}
					return lucide.ChevronRight()
				}, Label: apptext.T("展开供应商") + " " + provider.ID, Size: 24, IconSize: 13,
					TestID: "provider-expand-" + provider.ID, OnPress: func() { a.toggleProviderCard(provider.ID) }},
				name,
				ui.IconButton{Icon: lucide.ChevronUp, Label: apptext.T("上移供应商"), Size: 23, IconSize: 11,
					TestID: "provider-order-up-" + provider.ID, Disabled: func() bool { return index == 0 },
					OnPress: func() { a.moveConfiguredProvider(provider.ID, -1) }},
				ui.IconButton{Icon: lucide.ChevronDown, Label: apptext.T("下移供应商"), Size: 23, IconSize: 11,
					TestID: "provider-order-down-" + provider.ID, Disabled: func() bool { return index == len(list)-1 },
					OnPress: func() { a.moveConfiguredProvider(provider.ID, 1) }},
				ui.IconButton{Icon: lucide.Settings2, Label: apptext.T("配置") + " " + provider.ID, Size: 24, IconSize: 12,
					TestID: "provider-configure-" + provider.ID, OnPress: func() { a.openProviderDialog(provider.ID) }},
			}}
			rows = append(rows, header,
				core.Show{When: isOpen, Then: func(*core.Scope) core.Node { return a.configuredProviderDetails(provider) }})
			if i < len(list)-1 {
				rows = append(rows, setDivider())
			}
		}
		return core.View{Style: core.Style{Gap: 1}, Children: rows}
	})
}

func (a *app) toggleProviderCard(id string) {
	if a.providerCardOpen.GetUntracked() == id {
		a.providerCardOpen.Set("")
		return
	}
	a.providerCardOpen.Set(id)
	a.providerFetchError.Set("")
	a.providerFetchedModels.Set(nil)
	a.providerFetchedSelected.Set(map[string]bool{})
	a.providerModelQuery.Set("")
}

func (a *app) configuredProviderDetails(provider providerInfo) core.Node {
	colors := ui.ColorsOf(a.cx)
	var actions []core.Node
	fetchLabel := apptext.T("获取模型列表")
	if a.providerFetchBusy.Get() {
		fetchLabel = apptext.T("正在获取…")
	}
	actions = append(actions, ui.Button{Text: fetchLabel, Variant: ui.ButtonPrimary, Size: ui.SizeSmall,
		TestID: "provider-fetch-models-" + provider.ID, Disabled: func() bool {
			return a.providerFetchBusy.Get() || a.providerModelWriteBusy.Get()
		}, OnPress: func() { a.fetchConfiguredProviderModels(provider.ID) }})
	actions = append(actions, ui.Button{Text: apptext.T("添加模型"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
		TestID: "provider-model-add-manual-" + provider.ID, OnPress: func() { a.openProviderDialog(provider.ID) }})
	actions = append(actions, ui.Button{Text: apptext.T("用量与配置"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
		TestID: "provider-usage-" + provider.ID, OnPress: func() { a.openProviderDialog(provider.ID) }})
	actions = append(actions, ui.Button{Text: apptext.T("按字母排序"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
		TestID: "provider-model-sort-" + provider.ID, Disabled: func() bool {
			return a.providerModelWriteBusy.Get() || len(provider.Models) < 2
		}, OnPress: func() { a.sortConfiguredProviderModels(provider.ID) }})

	content := []core.Node{
		core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, AlignItems: core.AlignCenter, Gap: 6}, Children: actions},
		core.Text{Content: provider.API + endpointHostSuffix(provider.BaseURL), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
			Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
	}
	if errText := a.providerFetchError.Get(); errText != "" {
		content = append(content, core.Text{Content: errText, MaxLines: 3, Style: core.Style{FontSize: 10.5, LineHeight: 15},
			StyleFunc: ui.Colored(colors.Danger)})
	}
	content = append(content, a.configuredModelRows(provider))
	if a.providerFetchBusy.Get() {
		content = append(content, core.Text{Content: apptext.T("正在获取模型列表…"),
			Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Muted)})
	}
	if fetched := a.providerFetchedModels.Get(); len(fetched) > 0 {
		content = append(content, a.fetchedModelPicker(provider, fetched))
	}
	return core.View{Style: core.Style{Gap: 7, Padding: core.Edges{Left: 30, Right: 4, Bottom: 9}}, Children: content}
}

func (a *app) configuredModelRows(provider providerInfo) core.Node {
	colors := ui.ColorsOf(a.cx)
	models := append([]modelConfig(nil), provider.Models...)
	if len(models) == 0 {
		return core.Text{Content: apptext.T("还没有模型条目。拉取列表或手动添加模型。"),
			Style: core.Style{FontSize: 10.5, Padding: core.Symmetric(3, 0)}, StyleFunc: ui.Colored(colors.Muted)}
	}
	rows := make([]core.Node, 0, len(models))
	for i, model := range models {
		model := model
		index := i
		name := model.Name
		if name == "" {
			name = model.ID
		}
		meta := []string{model.ID}
		if model.ContextWindow > 0 {
			meta = append(meta, viewkit.Tokens(model.ContextWindow)+apptext.T("上下文"))
		}
		if model.MaxTokens > 0 {
			meta = append(meta, apptext.T("最大输出")+" "+viewkit.Tokens(model.MaxTokens))
		}
		if model.Reasoning {
			meta = append(meta, apptext.T("推理"))
		}
		if model.Images {
			meta = append(meta, apptext.T("图片"))
		}
		rows = append(rows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinHeight: core.Pt(30), Padding: core.Symmetric(2, 1)}, Children: []core.Node{
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
				core.Text{Content: name, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
					Style: core.Style{FontSize: 11.5}, StyleFunc: ui.Colored(colors.Text)},
				core.Text{Content: strings.Join(meta, " · "), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
					Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
			}},
			ui.IconButton{Icon: lucide.ChevronUp, Label: apptext.T("上移模型"), Size: 21, IconSize: 10,
				TestID: "provider-model-order-up-" + provider.ID + "-" + modelTestToken(model.ID), Disabled: func() bool {
					return index == 0 || a.providerModelWriteBusy.Get()
				}, OnPress: func() { a.moveConfiguredProviderModel(provider.ID, model.ID, -1) }},
			ui.IconButton{Icon: lucide.ChevronDown, Label: apptext.T("下移模型"), Size: 21, IconSize: 10,
				TestID: "provider-model-order-down-" + provider.ID + "-" + modelTestToken(model.ID), Disabled: func() bool {
					return index == len(models)-1 || a.providerModelWriteBusy.Get()
				}, OnPress: func() { a.moveConfiguredProviderModel(provider.ID, model.ID, 1) }},
		}})
		if i < len(models)-1 {
			rows = append(rows, setDivider())
		}
	}
	return core.View{Style: core.Style{Gap: 1}, Children: rows}
}

func (a *app) fetchedModelPicker(provider providerInfo, fetched []modelConfig) core.Node {
	colors := ui.ColorsOf(a.cx)
	query := strings.ToLower(strings.TrimSpace(a.providerModelQuery.Get()))
	existing := make(map[string]bool, len(provider.Models))
	for _, model := range provider.Models {
		existing[model.ID] = true
	}
	var rows []core.Node
	available := 0
	selectedCount := 0
	selected := a.providerFetchedSelected.Get()
	for _, model := range fetched {
		model := model
		if existing[model.ID] || (query != "" && !strings.Contains(strings.ToLower(model.ID+" "+model.Name), query)) {
			continue
		}
		available++
		if selected[model.ID] {
			selectedCount++
		}
		label := model.ID
		if model.Name != "" && model.Name != model.ID {
			label = model.Name + " · " + model.ID
		}
		rows = append(rows, ui.Checkbox{Label: label, TestID: "provider-fetched-model-" + modelTestToken(provider.ID) + "-" + modelTestToken(model.ID),
			Checked: func() bool { return a.providerFetchedSelected.Get()[model.ID] },
			OnChange: func(on bool) {
				a.providerFetchedSelected.Update(func(current map[string]bool) map[string]bool {
					next := make(map[string]bool, len(current)+1)
					for id, value := range current {
						next[id] = value
					}
					next[model.ID] = on
					return next
				})
			}})
	}
	picker := []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7}, Children: []core.Node{
			ui.Text(apptext.T("可添加模型"), 10.5, ui.Medium, colors.Muted),
			ui.Text(apptext.T("%d 个新模型", available), 10, ui.Regular, colors.Faint),
			core.View{Style: core.Style{FlexGrow: 1}},
			ui.Button{Text: apptext.T("添加所选"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
				TestID:   "provider-fetched-add-" + provider.ID,
				Disabled: func() bool { return selectedCount == 0 || a.providerModelWriteBusy.Get() },
				OnPress:  func() { a.addSelectedProviderModels(provider) }},
		}},
		ui.Input{Value: a.providerModelQuery.Get, OnChange: a.providerModelQuery.Set,
			Placeholder: apptext.T("筛选模型"), Label: apptext.T("筛选模型"), TestID: "provider-fetched-filter-" + provider.ID},
	}
	if available == 0 {
		picker = append(picker, core.Text{Content: apptext.T("没有可添加的新模型。"),
			Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)})
	} else {
		picker = append(picker, core.View{Style: core.Style{Gap: 2}, Children: rows})
	}
	return core.View{Style: core.Style{Gap: 5, Padding: core.Edges{Top: 5}}, Children: picker}
}

func modelTestToken(value string) string {
	var out strings.Builder
	for _, r := range value {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			out.WriteRune(r)
		} else {
			out.WriteByte('-')
		}
	}
	return strings.Trim(out.String(), "-")
}

func (a *app) fetchConfiguredProviderModels(id string) {
	if a.providerFetchBusy.GetUntracked() || a.providerModelWriteBusy.GetUntracked() {
		return
	}
	info, ok := a.providerInfoOf(id)
	if !ok || !info.Configured {
		a.providerFetchError.Set(apptext.T("models.json 中没有这个供应商。"))
		return
	}
	a.providerFetchBusy.Set(true)
	a.providerFetchError.Set("")
	a.providerFetchedModels.Set(nil)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		var cfg providerConfig
		found := false
		for _, item := range readProviderConfigs() {
			if item.ID == id {
				cfg, found = item, true
				break
			}
		}
		catalog := readCatalogProviders()
		for _, item := range catalog {
			if item.ID == id {
				if cfg.API == "" {
					cfg.API = item.API
				}
				if cfg.BaseURL == "" {
					cfg.BaseURL = item.BaseURL
				}
				break
			}
		}
		var models []modelConfig
		var err error
		if !found {
			err = errors.New(apptext.T("models.json 中没有这个供应商。"))
		} else {
			credential := resolveProviderModelCredential(ctx, a.piPath(), cfg)
			models, err = fetchProviderModelList(ctx, appHTTPClient, cfg, credential, catalog)
		}
		a.cx.Post(func() {
			a.providerFetchBusy.Set(false)
			if a.providerCardOpen.GetUntracked() != id {
				return
			}
			if err != nil {
				a.providerFetchError.Set(err.Error())
				return
			}
			existing := make(map[string]bool, len(info.Models))
			for _, model := range info.Models {
				existing[model.ID] = true
			}
			selected := make(map[string]bool)
			for _, model := range models {
				if !existing[model.ID] {
					selected[model.ID] = true
				}
			}
			a.providerFetchedModels.Set(models)
			a.providerFetchedSelected.Set(selected)
		})
	}()
}

func (a *app) addSelectedProviderModels(provider providerInfo) {
	if a.providerModelWriteBusy.GetUntracked() {
		return
	}
	selected := a.providerFetchedSelected.GetUntracked()
	models, added := appendSelectedProviderModels(provider.Models, a.providerFetchedModels.GetUntracked(), selected)
	if added == 0 {
		return
	}
	a.saveConfiguredProviderModels(provider.ID, models, apptext.T("已添加模型"), apptext.T("已保存 %d 个模型条目。", added))
}

func (a *app) sortConfiguredProviderModels(id string) {
	models, ok := a.configuredModels(id)
	if !ok {
		return
	}
	sortProviderModelsAlphabetically(models)
	a.saveConfiguredProviderModels(id, models, apptext.T("模型已排序"), apptext.T("模型已按名称排序。"))
}

func (a *app) moveConfiguredProviderModel(id, modelID string, delta int) {
	models, ok := a.configuredModels(id)
	if !ok {
		return
	}
	index := -1
	for i := range models {
		if models[i].ID == modelID {
			index = i
			break
		}
	}
	next := index + delta
	if index < 0 || next < 0 || next >= len(models) {
		return
	}
	models[index], models[next] = models[next], models[index]
	a.saveConfiguredProviderModels(id, models, apptext.T("模型顺序已更新"), apptext.T("模型顺序已保存。"))
}

func (a *app) configuredModels(id string) ([]modelConfig, bool) {
	for _, provider := range a.providers.GetUntracked() {
		if provider.ID == id && provider.Configured {
			return append([]modelConfig(nil), provider.Models...), true
		}
	}
	return nil, false
}

func (a *app) saveConfiguredProviderModels(id string, models []modelConfig, title, detail string) {
	if a.providerModelWriteBusy.GetUntracked() {
		return
	}
	a.providerModelWriteBusy.Set(true)
	go func() {
		err := saveProviderModels(id, models)
		a.cx.Post(func() {
			a.providerModelWriteBusy.Set(false)
			if err != nil {
				a.providerFetchError.Set(apptext.T("保存模型失败") + "：" + err.Error())
				a.toast(ui.ToastError, "保存模型失败", err.Error())
				return
			}
			a.providerFetchedModels.Set(nil)
			a.providerFetchError.Set("")
			a.toast(ui.ToastSuccess, title, detail)
			a.refreshProviders()
		})
	}()
}

func (a *app) moveConfiguredProvider(id string, delta int) {
	configured := make([]string, 0)
	isConfigured := make(map[string]bool)
	for _, provider := range a.providers.GetUntracked() {
		if provider.Configured {
			configured = append(configured, provider.ID)
			isConfigured[provider.ID] = true
		}
	}
	order := a.providerOrder()
	visible := make([]string, 0, len(configured))
	slots := make([]int, 0, len(configured))
	for index, provider := range order {
		if isConfigured[provider] {
			visible = append(visible, provider)
			slots = append(slots, index)
		}
	}
	index := -1
	for i, provider := range visible {
		if provider == id {
			index = i
			break
		}
	}
	next := index + delta
	if index < 0 || next < 0 || next >= len(visible) {
		return
	}
	visible[index], visible[next] = visible[next], visible[index]
	for i, slot := range slots {
		order[slot] = visible[i]
	}
	a.cfg.ProviderOrder = order
	a.st.edit(func(config *config) { config.ProviderOrder = append([]string(nil), order...) })
	a.bumpSettings()
}

func endpointHostSuffix(baseURL string) string {
	if host := providerEndpointHost(baseURL); host != "" {
		return " · " + host
	}
	return ""
}
