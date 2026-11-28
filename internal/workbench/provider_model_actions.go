//go:build !js && !android && !ios

package workbench

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) fetchConfiguredProviderModels(id string) {
	if a.providerFetchBusy.GetUntracked() || a.providerModelWriteBusy.GetUntracked() {
		return
	}
	h := a.providerManagerState()
	h.fetchSeq++
	seq, loadSeq := h.fetchSeq, h.loadSeq
	piPath := a.piPath()
	a.providerFetchBusy.Set(true)
	a.providerFetchError.Set("")
	a.providerFetchedModels.Set(nil)
	a.providerFetchedSelected.Set(map[string]bool{})
	h.fetchedLimit.Set(30)
	go func() {
		ctx, cancel := context.WithTimeout(a.lifetime, 25*time.Second)
		defer cancel()
		cfg, _, _, err := readProviderConnection(id)
		catalog := readCatalogProviders()
		for _, p := range catalog {
			if p.ID == id {
				if cfg.API == "" {
					cfg.API = p.API
				}
				if cfg.BaseURL == "" {
					cfg.BaseURL = p.BaseURL
				}
				break
			}
		}
		var models []modelConfig
		if err == nil {
			credential := resolveProviderModelCredential(ctx, piPath, cfg)
			models, err = fetchProviderModelList(ctx, appHTTPClient, cfg, credential, catalog)
		}
		a.cx.Post(func() {
			if h.fetchSeq != seq || h.loadSeq != loadSeq || a.providerID.GetUntracked() != id {
				return
			}
			a.providerFetchBusy.Set(false)
			if err != nil {
				a.providerFetchError.Set(err.Error())
				return
			}
			if len(models) == 0 {
				a.providerFetchError.Set(apptext.T("供应商返回了空列表，可以手动添加模型。"))
				return
			}
			a.providerFetchedModels.Set(models)
			a.providerFetchedSelected.Set(map[string]bool{})
			a.providerModelQuery.Set("")
		})
	}()
}

func mutateProviderModelEntries(id string, change func([]any) ([]any, error)) error {
	return mutateModelsDocument(false, func(providers map[string]any) error {
		p, err := providerDocument(providers, id)
		if err != nil {
			return err
		}
		list, _ := p["models"].([]any)
		for _, v := range list {
			m, ok := v.(map[string]any)
			if !ok || strings.TrimSpace(strField(m["id"])) == "" {
				return errors.New(apptext.T("模型条目无效，请先检查 models.json。"))
			}
		}
		next, err := change(list)
		if err != nil {
			return err
		}
		p["models"] = next
		return nil
	})
}

func (a *app) addSelectedProviderModels(provider providerInfo) {
	selected := map[string]bool{}
	for id, on := range a.providerFetchedSelected.GetUntracked() {
		selected[id] = on
	}
	fetched := append([]modelConfig(nil), a.providerFetchedModels.GetUntracked()...)
	a.runProviderModelMutation(provider.ID, apptext.T("已添加模型"), func() error {
		return mutateProviderModelEntries(provider.ID, func(list []any) ([]any, error) {
			existing := map[string]bool{}
			for _, v := range list {
				existing[strField(v.(map[string]any)["id"])] = true
			}
			for _, m := range fetched {
				if selected[m.ID] && !existing[m.ID] {
					entry := map[string]any{}
					applyModelEntry(entry, m)
					list = append(list, entry)
					existing[m.ID] = true
				}
			}
			return list, nil
		})
	})
}

func (a *app) sortConfiguredProviderModels(id string) {
	a.runProviderModelMutation(id, apptext.T("模型已排序"), func() error {
		return mutateProviderModelEntries(id, func(list []any) ([]any, error) {
			label := func(v any) string {
				m := v.(map[string]any)
				name := strField(m["name"])
				if name == "" {
					name = strField(m["id"])
				}
				return strings.ToLower(name)
			}
			sort.SliceStable(list, func(i, j int) bool { return label(list[i]) < label(list[j]) })
			return list, nil
		})
	})
}

func (a *app) moveConfiguredProviderModel(id, modelID string, delta int) {
	a.runProviderModelMutation(id, apptext.T("模型顺序已更新"), func() error {
		return mutateProviderModelEntries(id, func(list []any) ([]any, error) {
			index := -1
			for i, v := range list {
				if strField(v.(map[string]any)["id"]) == modelID {
					index = i
					break
				}
			}
			next := index + delta
			if index < 0 {
				return nil, errors.New(apptext.T("模型已被修改或删除，请重新打开。"))
			}
			if next >= 0 && next < len(list) {
				list[index], list[next] = list[next], list[index]
			}
			return list, nil
		})
	})
}

func (a *app) configuredModels(id string) ([]modelConfig, bool) {
	if a.providerManager != nil && a.providerID.GetUntracked() == id && a.providerOpen.GetUntracked() {
		return append([]modelConfig(nil), a.providerModels...), true
	}
	for _, p := range a.providers.GetUntracked() {
		if p.ID == id && p.Configured {
			return append([]modelConfig(nil), p.Models...), true
		}
	}
	return nil, false
}

func (a *app) saveConfiguredProviderModels(id string, models []modelConfig, title, detail string) {
	a.runProviderModelMutation(id, title, func() error { return saveProviderModels(id, models) })
}

func (a *app) runProviderModelMutation(id, title string, mutation func() error, onSaved ...func()) {
	h := a.providerManagerState()
	if a.providerModelWriteBusy.GetUntracked() || h.busy.GetUntracked() {
		return
	}
	a.providerModelWriteBusy.Set(true)
	h.busy.Set(true)
	seq := h.loadSeq
	go func() {
		err := mutation()
		cfg, _, _, readErr := readProviderConnection(id)
		a.cx.Post(func() {
			a.providerModelWriteBusy.Set(false)
			h.busy.Set(false)
			if err != nil {
				a.providerFetchError.Set(err.Error())
				a.toast(ui.ToastError, "保存模型失败", err.Error())
				return
			}
			if seq == h.loadSeq && a.providerID.GetUntracked() == id && readErr == nil {
				a.providerModels = cfg.Models
				a.providerModelsRev.Update(func(n int) int { return n + 1 })
				a.providerFetchedModels.Set(nil)
				a.providerFetchError.Set("")
			}
			for _, fn := range onSaved {
				fn()
			}
			a.toast(ui.ToastSuccess, title, apptext.T("模型配置已保存。"))
			a.refreshProviders()
		})
	}()
}

func (a *app) moveConfiguredProvider(id string, delta int) {
	isConfigured := map[string]bool{}
	for _, p := range a.providers.GetUntracked() {
		if p.Configured {
			isConfigured[p.ID] = true
		}
	}
	order := a.providerOrder()
	var slots []int
	var visible []string
	for i, id := range order {
		if isConfigured[id] {
			slots = append(slots, i)
			visible = append(visible, id)
		}
	}
	index := -1
	for i, p := range visible {
		if p == id {
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
	a.st.edit(func(c *config) { c.ProviderOrder = append([]string(nil), order...) })
	a.bumpSettings()
}

func (a *app) cloneConfiguredProvider(id string) {
	next := id + "-copy"
	for i := 2; ; i++ {
		if _, exists := a.providerInfoOf(next); !exists {
			break
		}
		next = fmt.Sprintf("%s-copy-%d", id, i)
	}
	a.askConfirmPrimary(apptext.T("复制供应商？"), apptext.T("复制连接、密钥和模型到 %s；用量查询单独配置。", next), apptext.T("复制供应商"), func() {
		go func() {
			err := cloneProviderConfig(id, next)
			a.cx.Post(func() {
				if err != nil {
					a.toast(ui.ToastError, "复制失败", err.Error())
					return
				}
				a.refreshProviders()
				a.openProviderSection(next, "connection", nil)
				a.toast(ui.ToastSuccess, "供应商已复制", next)
			})
		}()
	})
}

func (a *app) deleteConfiguredProvider(id string) {
	a.askConfirm(apptext.T("删除供应商？"), apptext.T("移除 %s 的自定义连接和模型配置。会话记录、pi 登录凭据和独立用量配置会保留。", id), apptext.T("删除供应商"), func() {
		go func() {
			err := deleteProviderConfig(id)
			a.cx.Post(func() {
				if err != nil {
					a.toast(ui.ToastError, "删除失败", err.Error())
					return
				}
				a.providerCardOpen.Set("")
				a.migrateProviderPreferences(id, "", "", "")
				a.refreshProviders()
				a.toast(ui.ToastInfo, "供应商已删除", id)
			})
		}()
	})
}
