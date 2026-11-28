//go:build !js && !android && !ios

package workbench

import (
	"context"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// providerManagerState holds drafts only. Saved configuration is read again
// whenever the manager opens; background catalog updates never reset a draft.
type providerManagerState struct {
	page, tab, problem, headers                                     *core.Signal[string]
	loading, busy, testBusy, dirty, modelDirty, modelForm, advanced *core.Signal[bool]
	modelQuery, modelActions                                        *core.Signal[string]
	modelLimit, fetchedLimit                                        *core.Signal[int]
	compat                                                          map[string]bool
	compatRev                                                       *core.Signal[int]
	configured                                                      bool
	loadSeq, fetchSeq                                               uint64
	usage                                                           *providerUsageForm
	providerLimit                                                   *core.Signal[int]
	selectedProviders, selectedModels                               *core.Signal[map[string]bool]
	transfer                                                        *core.Signal[string]
	transferForm                                                    *providerTransferForm
	modelAdvancedOpen                                               *core.Signal[bool]
	modelAdvanced                                                   *providerModelAdvancedForm
}

func (a *app) providerManagerState() *providerManagerState {
	if a.providerManager == nil {
		a.providerManager = &providerManagerState{
			page: core.NewSignal(a.cx, "providers"), tab: core.NewSignal(a.cx, "connection"), problem: core.NewSignal(a.cx, ""), headers: core.NewSignal(a.cx, ""),
			loading: core.NewSignal(a.cx, false), busy: core.NewSignal(a.cx, false), testBusy: core.NewSignal(a.cx, false), dirty: core.NewSignal(a.cx, false), modelDirty: core.NewSignal(a.cx, false), modelForm: core.NewSignal(a.cx, false), advanced: core.NewSignal(a.cx, false),
			modelQuery: core.NewSignal(a.cx, ""), modelActions: core.NewSignal(a.cx, ""), modelLimit: core.NewSignal(a.cx, 30), fetchedLimit: core.NewSignal(a.cx, 30), compatRev: core.NewSignal(a.cx, 0),
			providerLimit: core.NewSignal(a.cx, 30), selectedProviders: core.NewSignalFunc(a.cx, map[string]bool{}, nil), selectedModels: core.NewSignalFunc(a.cx, map[string]bool{}, nil), transfer: core.NewSignal(a.cx, ""), modelAdvancedOpen: core.NewSignal(a.cx, false),
		}
	}
	return a.providerManager
}

func (a *app) openProviderDialog(id string) { a.openProviderSection(id, "connection", nil) }

func (a *app) openProviderSection(id, tab string, model *modelConfig) {
	if a.providerOpen == nil {
		return
	}
	h := a.providerManagerState()
	if h.usage != nil && h.usage.refreshTimer != nil {
		h.usage.refreshTimer.Stop()
	}
	h.loadSeq++
	h.fetchSeq++
	h.transfer.Set("")
	h.modelAdvancedOpen.Set(false)
	h.selectedModels.Set(map[string]bool{})
	h.testBusy.Set(false)
	a.providerFetchBusy.Set(false)
	a.providerFetchError.Set("")
	a.providerFetchedModels.Set(nil)
	a.providerFetchedSelected.Set(map[string]bool{})
	seq := h.loadSeq
	h.tab.Set(tab)
	h.problem.Set("")
	h.dirty.Set(false)
	h.modelDirty.Set(false)
	h.modelForm.Set(false)
	h.advanced.Set(false)
	h.modelQuery.Set("")
	h.modelLimit.Set(30)
	a.providerID.Set(id)
	a.providerAPI.Set("")
	a.providerBase.Set("")
	a.providerKeySig.Set("")
	a.providerModels = nil
	a.providerTest.Set("")
	a.providerBalance.Set("")
	a.resetModelForm()
	h.usage = nil
	a.providerOpen.Set(true)
	if id == "" {
		h.loading.Set(false)
		return
	}
	h.loading.Set(true)
	info, _ := a.providerInfoOf(id)
	spec := a.cfg.Balances[id]
	go func() {
		cfg, headers, compat, err := readProviderConnection(id)
		configured := err == nil
		if err != nil && !info.Configured {
			cfg = providerConfig{ID: id, API: info.API, BaseURL: info.BaseURL}
			err = nil
		}
		usage, usageConfigured, usageErr := loadUsageProbeConfig(id)
		a.cx.Post(func() {
			if h.loadSeq != seq || !a.providerOpen.GetUntracked() {
				return
			}
			h.loading.Set(false)
			h.configured = configured
			if err != nil {
				h.problem.Set(err.Error())
				return
			}
			a.providerAPI.Set(cfg.API)
			a.providerBase.Set(cfg.BaseURL)
			a.providerKeySig.Set(cfg.APIKey)
			a.providerModels = cfg.Models
			h.headers.Set(providerHeadersText(headers))
			h.compat = compat
			a.providerBalURL.Set(spec.URL)
			a.providerBalPath.Set(spec.Path)
			a.providerBalCur.Set(spec.Currency)
			h.usage = a.newProviderUsageForm(cfg, usage, usageConfigured, usageErr)
			a.providerModelsRev.Update(func(n int) int { return n + 1 })
			if model != nil {
				a.editProviderModel(*model)
				h.modelForm.Set(true)
			}
		})
	}()
}

func (a *app) closeProviderManager() {
	h := a.providerManagerState()
	if h.busy.GetUntracked() || (h.usage != nil && h.usage.busy.GetUntracked()) {
		return
	}
	close := func() {
		if h.usage != nil && h.usage.refreshTimer != nil {
			h.usage.refreshTimer.Stop()
		}
		h.loadSeq++
		h.fetchSeq++
		a.providerOpen.Set(false)
		a.providerKeySig.Set("")
		h.usage = nil
		h.modelAdvancedOpen.Set(false)
	}
	usageDirty := h.usage != nil && h.usage.dirty.GetUntracked()
	if h.dirty.GetUntracked() || h.modelDirty.GetUntracked() || usageDirty {
		a.askConfirmPrimary(apptext.T("放弃未保存的更改？"), apptext.T("连接、模型或用量配置尚未保存。"), apptext.T("放弃更改"), close)
		return
	}
	close()
}

func (a *app) providerFromDialog() providerConfig {
	headers, _ := parseProviderHeaders(a.providerManagerState().headers.GetUntracked())
	return providerConfig{Headers: headers, ID: a.providerID.GetUntracked(), API: strings.TrimSpace(a.providerAPI.GetUntracked()), BaseURL: strings.TrimSpace(a.providerBase.GetUntracked()), APIKey: strings.TrimSpace(a.providerKeySig.GetUntracked()), Models: append([]modelConfig(nil), a.providerModels...)}
}

func (a *app) saveProvider() {
	h := a.providerManagerState()
	if h.busy.GetUntracked() || h.loading.GetUntracked() {
		return
	}
	cfg := a.providerFromDialog()
	if cfg.BaseURL != "" {
		if _, err := providerModelEndpoints(cfg.BaseURL, cfg.API, ""); err != nil {
			h.problem.Set(err.Error())
			return
		}
	}
	headers, err := parseProviderHeaders(h.headers.GetUntracked())
	if err != nil {
		h.problem.Set(err.Error())
		return
	}
	compat := map[string]bool{}
	for k, v := range h.compat {
		compat[k] = v
	}
	configured := h.configured
	h.busy.Set(true)
	h.problem.Set("")
	go func() {
		var err error
		if !configured {
			copy := cfg
			copy.Models = nil
			err = writeProviderConfig(copy, true)
		}
		if err == nil {
			err = updateProviderConnection(cfg, headers, compat)
		}
		a.cx.Post(func() {
			h.busy.Set(false)
			if a.providerID.GetUntracked() != cfg.ID {
				return
			}
			if err != nil {
				h.problem.Set(err.Error())
				return
			}
			h.configured = true
			h.dirty.Set(false)
			a.toast(ui.ToastSuccess, "连接设置已保存", "新会话使用新配置；已运行的会话需重启 Agent。")
			a.refreshProviders()
		})
	}()
}

func (a *app) testProvider() {
	h := a.providerManagerState()
	if h.testBusy.GetUntracked() {
		return
	}
	cfg := a.providerFromDialog()
	seq := h.loadSeq
	piPath := a.piPath()
	h.testBusy.Set(true)
	a.providerTest.Set(apptext.T("正在测试…"))
	go func() {
		ctx, cancel := context.WithTimeout(a.lifetime, 25*time.Second)
		defer cancel()
		credential, err := resolveProviderDraftCredential(ctx, piPath, cfg)
		msg := ""
		if err == nil {
			msg, err = testProviderConnectionWith(ctx, appHTTPClient, cfg, credential)
		}
		a.cx.Post(func() {
			if h.loadSeq != seq {
				return
			}
			h.testBusy.Set(false)
			if err != nil {
				a.providerTest.Set(apptext.T("失败：%s", err.Error()))
				return
			}
			a.providerTest.Set(msg)
		})
	}()
}

// The old custom balance settings remain readable during the transition.
func (a *app) dialogBalanceSpec() *balanceSpec {
	spec := balanceSpec{URL: strings.TrimSpace(a.providerBalURL.GetUntracked()), Path: strings.TrimSpace(a.providerBalPath.GetUntracked()), Currency: strings.TrimSpace(a.providerBalCur.GetUntracked())}
	if spec.URL == "" && spec.Path == "" && spec.Currency == "" {
		return nil
	}
	return &spec
}
func (a *app) queryProviderBalance() { a.testProviderUsage() }

func (a *app) resetModelForm() {
	a.providerModelEditing.Set("")
	a.providerModelID.Set("")
	a.providerModelName.Set("")
	a.providerModelContext.Set("")
	a.providerModelMax.Set("")
	a.providerModelReasoning.Set(false)
	a.providerModelImages.Set(false)
	a.providerModelCostIn.Set("")
	a.providerModelCostOut.Set("")
	a.providerModelCostRead.Set("")
	a.providerModelCostWrite.Set("")
	a.modelCompat = nil
	a.modelCompatSuggestion = nil
	a.modelCompatRev.Update(func(n int) int { return n + 1 })
	if a.providerManager != nil {
		a.providerManager.modelDirty.Set(false)
	}
}

func (a *app) editProviderModel(m modelConfig) {
	a.providerModelEditing.Set(m.ID)
	a.providerModelID.Set(m.ID)
	a.providerModelName.Set(m.Name)
	a.providerModelContext.Set(modelNumber(m.ContextWindow))
	a.providerModelMax.Set(modelNumber(m.MaxTokens))
	a.providerModelReasoning.Set(m.Reasoning)
	a.providerModelImages.Set(m.Images)
	a.providerModelCostIn.Set(priceNumber(m.Cost.Input))
	a.providerModelCostOut.Set(priceNumber(m.Cost.Output))
	a.providerModelCostRead.Set(priceNumber(m.Cost.CacheRead))
	a.providerModelCostWrite.Set(priceNumber(m.Cost.CacheWrite))
	a.modelCompat = map[string]bool{}
	for k, v := range m.Compat {
		a.modelCompat[k] = v
	}
	a.modelCompatSuggestion = nil
	a.modelCompatRev.Update(func(n int) int { return n + 1 })
	h := a.providerManagerState()
	h.modelDirty.Set(false)
	h.modelForm.Set(true)
}

func priceNumber(v float64) string {
	if v <= 0 {
		return ""
	}
	return strconv.FormatFloat(v, 'f', -1, 64)
}
func modelPrice(text string) float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
	if err != nil || v < 0 {
		return 0
	}
	return v
}
func modelNumber(n int) string {
	if n <= 0 {
		return ""
	}
	return strconv.Itoa(n)
}
func modelCount(text string) int {
	n, err := strconv.Atoi(strings.TrimSpace(text))
	if err != nil || n < 0 {
		return 0
	}
	return n
}

func (a *app) cancelProviderModel() {
	h := a.providerManagerState()
	if h.busy.GetUntracked() {
		return
	}
	close := func() { a.resetModelForm(); h.modelForm.Set(false); h.problem.Set("") }
	if h.modelDirty.GetUntracked() {
		a.askConfirmPrimary(apptext.T("放弃模型更改？"), apptext.T("当前模型尚未保存。"), apptext.T("放弃更改"), close)
	} else {
		close()
	}
}

func (a *app) testManagedProviderModel(model string) {
	h := a.providerManagerState()
	if h.testBusy.GetUntracked() {
		return
	}
	cfg, seq, piPath := a.providerFromDialog(), h.loadSeq, a.piPath()
	h.testBusy.Set(true)
	a.providerTest.Set(apptext.T("正在测试模型 %s…", model))
	go func() {
		ctx, cancel := context.WithTimeout(a.lifetime, 25*time.Second)
		defer cancel()
		credential, err := resolveProviderDraftCredential(ctx, piPath, cfg)
		message := ""
		if err == nil {
			message, err = testProviderModelWith(ctx, appHTTPClient, cfg, model, credential)
		}
		a.cx.Post(func() {
			if h.loadSeq != seq {
				return
			}
			h.testBusy.Set(false)
			if err != nil {
				a.providerTest.Set(model + " · " + err.Error())
			} else {
				a.providerTest.Set(model + " · " + message)
			}
		})
	}()
}

func (a *app) saveProviderModel() {
	h := a.providerManagerState()
	if h.busy.GetUntracked() {
		return
	}
	if err := validateModelNumbers(a.providerModelContext.GetUntracked(), a.providerModelMax.GetUntracked(), a.providerModelCostIn.GetUntracked(), a.providerModelCostOut.GetUntracked(), a.providerModelCostRead.GetUntracked(), a.providerModelCostWrite.GetUntracked()); err != nil {
		h.problem.Set(err.Error())
		return
	}
	m := modelConfig{ID: strings.TrimSpace(a.providerModelID.GetUntracked()), Name: strings.TrimSpace(a.providerModelName.GetUntracked()), ContextWindow: modelCount(a.providerModelContext.GetUntracked()), MaxTokens: modelCount(a.providerModelMax.GetUntracked()), Reasoning: a.providerModelReasoning.GetUntracked(), Images: a.providerModelImages.GetUntracked(), Cost: modelCost{Input: modelPrice(a.providerModelCostIn.GetUntracked()), Output: modelPrice(a.providerModelCostOut.GetUntracked()), CacheRead: modelPrice(a.providerModelCostRead.GetUntracked()), CacheWrite: modelPrice(a.providerModelCostWrite.GetUntracked())}, Compat: map[string]bool{}}
	if m.ID == "" {
		h.problem.Set(apptext.T("还差模型 ID"))
		return
	}
	for k, v := range a.modelCompat {
		m.Compat[k] = v
	}
	provider, editing := a.providerID.GetUntracked(), a.providerModelEditing.GetUntracked()
	h.busy.Set(true)
	h.problem.Set("")
	go func() {
		err := writeProviderModel(provider, editing, m)
		var referenceErr error
		if err == nil && editing != "" && editing != m.ID {
			referenceErr = migrateModelThinkingReferences(provider, editing, m.ID)
		}
		cfg, _, _, readErr := readProviderConnection(provider)
		a.cx.Post(func() {
			h.busy.Set(false)
			if a.providerID.GetUntracked() != provider {
				return
			}
			if err != nil {
				h.problem.Set(err.Error())
				return
			}
			if editing != "" && editing != m.ID {
				a.migrateProviderPreferences(provider, editing, provider, m.ID)
			}
			if readErr == nil {
				a.providerModels = cfg.Models
			}
			a.providerModelsRev.Update(func(n int) int { return n + 1 })
			a.resetModelForm()
			h.modelForm.Set(false)
			a.refreshProviders()
			a.toast(ui.ToastSuccess, "模型已保存", m.ID)
			if referenceErr != nil {
				a.toast(ui.ToastError, "思考档位迁移失败", referenceErr.Error())
			}
		})
	}()
}

func (a *app) removeProviderModel(id string) {
	h := a.providerManagerState()
	provider := a.providerID.GetUntracked()
	a.askConfirm(apptext.T("删除模型？"), apptext.T("从 %s 移除模型 %s，不会删除会话记录。", provider, id), apptext.T("删除模型"), func() {
		if h.busy.GetUntracked() {
			return
		}
		h.busy.Set(true)
		go func() {
			err := deleteProviderModel(provider, id)
			var referenceErr error
			if err == nil {
				referenceErr = migrateModelThinkingReferences(provider, id, "")
			}
			cfg, _, _, _ := readProviderConnection(provider)
			a.cx.Post(func() {
				h.busy.Set(false)
				if err != nil {
					h.problem.Set(err.Error())
					return
				}
				a.migrateProviderPreferences(provider, id, "", "")
				if referenceErr != nil {
					a.toast(ui.ToastError, "思考档位清理失败", referenceErr.Error())
				}
				a.providerModels = cfg.Models
				a.providerModelsRev.Update(func(n int) int { return n + 1 })
				if a.providerModelEditing.GetUntracked() == id {
					a.resetModelForm()
					h.modelForm.Set(false)
				}
				a.refreshProviders()
				a.toast(ui.ToastInfo, "已删除模型", id)
			})
		}()
	})
}

func (a *app) refreshProviders() { a.loadAuth(); a.loadProviders(a.piPath()) }
func (a *app) openPiConfigFile(name string) {
	dir := piConfigDir()
	if dir == "" {
		a.toast(ui.ToastError, "找不到 pi 的配置目录", "")
		return
	}
	a.closePane(paneSettings)
	a.providerOpen.Set(false)
	a.openEditorFile(dir, filepath.Join(dir, name))
}
