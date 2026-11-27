//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"hash/fnv"
	"sort"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) configuredProviderCards() core.Node {
	h := a.providerManagerState()
	return core.Dynamic(func(cx *core.Scope) core.Node {
		a.settingsTick()
		colors := ui.ColorsOf(cx)
		query := strings.ToLower(strings.TrimSpace(a.providerQuery.Get()))
		var list []providerInfo
		for _, p := range a.providers.Get() {
			if p.Configured && (query == "" || strings.Contains(strings.ToLower(p.ID+" "+p.API+" "+p.BaseURL), query)) {
				list = append(list, p)
			}
		}
		rank := map[string]int{}
		for i, id := range a.providerOrder() {
			rank[id] = i
		}
		sort.SliceStable(list, func(i, j int) bool { return rank[list[i].ID] < rank[list[j].ID] })
		if len(list) == 0 {
			message := apptext.T("还没有供应商。添加连接后，获取模型列表或手动添加模型，即可开始使用。")
			if query != "" {
				message = apptext.T("没有匹配的供应商，可清空搜索或添加新的供应商。")
			}
			return core.Text{Content: message, TestID: "provider-empty", Style: core.Style{FontSize: 12, LineHeight: 18, Padding: core.Symmetric(18, 0)}, StyleFunc: ui.Colored(colors.Muted)}
		}
		rows := make([]core.Node, 0, len(list))
		limit := h.providerLimit.Get()
		for i, entry := range list {
			if i >= limit {
				break
			}
			p, index := entry, i
			open := func() bool { return a.providerCardOpen.Get() == p.ID }
			rows = append(rows, core.View{TestID: "provider-card-" + p.ID, Style: core.Style{Gap: 10, Padding: core.Symmetric(14, 0)}, Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
					ui.Checkbox{Text: p.ID, TestID: "provider-select-" + p.ID, Checked: func() bool { return h.selectedProviders.Get()[p.ID] }, OnChange: func(on bool) { selectionSet(h.selectedProviders, p.ID, on) }},
					core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}},
					ui.Text(apptext.T("%d 个模型", len(p.Models)), 11, ui.Regular, colors.Muted),
					ui.IconButton{Icon: func() *core.SVG {
						if open() {
							return lucide.ChevronUp()
						}
						return lucide.ChevronDown()
					}, Label: apptext.T("更多供应商操作"), Size: 26, IconSize: 14, TestID: "provider-expand-" + p.ID, OnPress: func() { a.toggleProviderCard(p.ID) }},
				}},
				core.Text{Content: providerLabel(p.API) + endpointHostSuffix(p.BaseURL), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle, Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
					ui.Button{Text: apptext.T("连接设置"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "provider-configure-" + p.ID, OnPress: func() { a.openProviderSection(p.ID, "connection", nil) }},
					ui.Button{Text: apptext.T("管理模型"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "provider-manage-models-" + p.ID, OnPress: func() { a.openProviderSection(p.ID, "models", nil) }},
					ui.Button{Text: apptext.T("用量查询"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "provider-usage-" + p.ID, OnPress: func() { a.openProviderSection(p.ID, "usage", nil) }},
				}},
				core.Show{When: open, Then: func(cx *core.Scope) core.Node {
					return core.View{Style: core.Style{Gap: 10}, Children: []core.Node{
						core.Text{Content: apptext.T("连接设置管理密钥和地址；模型管理负责添加、编辑、排序及收藏；用量查询单独保存。"), Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Muted)},
						core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
							ui.Button{Text: apptext.T("上移"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "provider-order-up-" + p.ID, Disabled: func() bool { return index == 0 || query != "" }, OnPress: func() { a.moveConfiguredProvider(p.ID, -1) }},
							ui.Button{Text: apptext.T("下移"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "provider-order-down-" + p.ID, Disabled: func() bool { return index == len(list)-1 || query != "" }, OnPress: func() { a.moveConfiguredProvider(p.ID, 1) }},
							ui.Button{Text: apptext.T("复制供应商"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "provider-clone-" + p.ID, OnPress: func() { a.cloneConfiguredProvider(p.ID) }},
							ui.Button{Text: apptext.T("删除供应商"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "provider-delete-" + p.ID, OnPress: func() { a.deleteConfiguredProvider(p.ID) }},
						}},
					}}
				}},
				setDivider(),
			}})
		}
		if len(list) > limit {
			rows = append(rows, ui.Button{Text: apptext.T("加载更多供应商（剩余 %d 个）", len(list)-limit), TestID: "provider-load-more", OnPress: func() { h.providerLimit.Update(func(n int) int { return n + 30 }) }})
		}
		return core.View{Style: core.Style{Gap: 0}, Children: rows}
	})
}

func (a *app) toggleProviderCard(id string) {
	if a.providerCardOpen.GetUntracked() == id {
		a.providerCardOpen.Set("")
	} else {
		a.providerCardOpen.Set(id)
	}
}

func (a *app) fetchedModelPicker(provider providerInfo, fetched []modelConfig) core.Node {
	h := a.providerManagerState()
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		query := strings.ToLower(strings.TrimSpace(a.providerModelQuery.Get()))
		existing := map[string]bool{}
		for _, m := range provider.Models {
			existing[m.ID] = true
		}
		selected := a.providerFetchedSelected.Get()
		selectedCount := 0
		for id, on := range selected {
			if on && !existing[id] {
				selectedCount++
			}
		}
		var rows []core.Node
		available := 0
		limit := h.fetchedLimit.Get()
		for _, entry := range fetched {
			m := entry
			if existing[m.ID] || (query != "" && !strings.Contains(strings.ToLower(m.ID+" "+m.Name), query)) {
				continue
			}
			available++
			if available > limit {
				continue
			}
			label := m.ID
			if m.Name != "" && m.Name != m.ID {
				label = m.Name + " · " + m.ID
			}
			rows = append(rows, ui.Checkbox{Text: label, TestID: "provider-fetched-model-" + modelTestToken(provider.ID) + "-" + modelTestToken(m.ID), Checked: func() bool { return a.providerFetchedSelected.Get()[m.ID] }, OnChange: func(on bool) {
				a.providerFetchedSelected.Update(func(current map[string]bool) map[string]bool {
					next := map[string]bool{}
					for id, v := range current {
						next[id] = v
					}
					next[m.ID] = on
					return next
				})
			}})
		}
		content := []core.Node{
			ui.Text(apptext.T("选择要添加的模型"), 13, ui.Semibold, colors.Text),
			ui.Text(apptext.T("已选 %d 个；搜索不会清除已选项。仅添加勾选的模型。", selectedCount), 11, ui.Regular, colors.Muted),
			ui.Input{Value: a.providerModelQuery.Get, OnChange: func(v string) { a.providerModelQuery.Set(v); h.fetchedLimit.Set(30) }, Label: apptext.T("筛选模型"), Placeholder: apptext.T("搜索远程模型名称或 ID"), TestID: "provider-fetched-filter-" + provider.ID},
			core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
				ui.Button{Text: apptext.T("选择搜索结果"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "provider-fetched-select-visible", OnPress: func() {
					next := map[string]bool{}
					for id, v := range a.providerFetchedSelected.GetUntracked() {
						next[id] = v
					}
					for _, m := range fetched {
						if !existing[m.ID] && (query == "" || strings.Contains(strings.ToLower(m.ID+" "+m.Name), query)) {
							next[m.ID] = true
						}
					}
					a.providerFetchedSelected.Set(next)
				}},
				ui.Button{Text: apptext.T("清空选择"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "provider-fetched-clear", OnPress: func() { a.providerFetchedSelected.Set(map[string]bool{}) }},
			}},
		}
		content = append(content, rows...)
		if available == 0 {
			content = append(content, ui.Text(apptext.T("没有可添加的新模型；已有模型不会重复添加。"), 11, ui.Regular, colors.Muted))
		}
		if available > limit {
			content = append(content, ui.Button{Text: apptext.T("加载更多（剩余 %d 个）", available-limit), Variant: ui.ButtonGhost, TestID: "provider-fetched-load-more", OnPress: func() { h.fetchedLimit.Update(func(n int) int { return n + 30 }) }})
		}
		content = append(content, ui.Button{Text: apptext.T("添加所选（%d）", selectedCount), Size: ui.SizeSmall, Variant: ui.ButtonPrimary, TestID: "provider-fetched-add-" + provider.ID, Disabled: func() bool { return selectedCount == 0 || a.providerModelWriteBusy.Get() }, OnPress: func() { a.addSelectedProviderModels(provider) }})
		return core.View{Style: core.Style{Gap: 9, Padding: core.Symmetric(12, 0)}, Children: content}
	})
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
	token := strings.Trim(out.String(), "-")
	if token == value && token != "" {
		return token
	}
	h := fnv.New32a()
	_, _ = h.Write([]byte(value))
	return fmt.Sprintf("%s-%08x", token, h.Sum32())
}

func endpointHostSuffix(baseURL string) string {
	if host := providerEndpointHost(baseURL); host != "" {
		return " · " + host
	}
	return ""
}
