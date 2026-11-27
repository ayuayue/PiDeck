//go:build !js && !android && !ios

package workbench

import (
	"errors"
	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
	"strconv"
	"strings"
)

type providerModelAdvancedForm struct {
	id                       string
	loaded                   bool
	agent, thinking, problem *core.Signal[string]
	loading, dirty           *core.Signal[bool]
	rev                      *core.Signal[int]
	cfg                      modelAdvancedConfig
	tiers                    []*providerModelTier
}
type providerModelTier struct {
	original map[string]any
	fields   map[string]*core.Signal[string]
}

var managedThinkingLevels = []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

func (a *app) openProviderModelAdvanced(id string) {
	h := a.providerManagerState()
	provider, seq := a.providerID.GetUntracked(), h.loadSeq
	f := &providerModelAdvancedForm{id: id, agent: core.NewSignal(a.cx, ""), thinking: core.NewSignal(a.cx, ""), problem: core.NewSignal(a.cx, ""), loading: core.NewSignal(a.cx, true), dirty: core.NewSignal(a.cx, false), rev: core.NewSignal(a.cx, 0)}
	h.modelAdvanced = f
	h.modelAdvancedOpen.Set(true)
	h.modelDirty.Set(false)
	go func() {
		cfg, err := readModelAdvanced(provider, id)
		thinking, thinkErr := readModelThinkingDefault(provider, id)
		if err == nil {
			err = thinkErr
		}
		a.cx.Post(func() {
			if seq != h.loadSeq || h.modelAdvanced != f {
				return
			}
			f.loading.Set(false)
			if err != nil {
				f.problem.Set(err.Error())
				return
			}
			f.cfg = cfg
			f.loaded = true
			if f.cfg.ThinkingLevelMap == nil {
				f.cfg.ThinkingLevelMap = map[string]any{}
			}
			f.agent.Set(cfg.UserAgent)
			f.thinking.Set(thinking)
			for _, tier := range cfg.Tiers {
				f.tiers = append(f.tiers, a.newProviderModelTier(tier))
			}
			f.rev.Update(func(n int) int { return n + 1 })
		})
	}()
}
func (a *app) newProviderModelTier(source map[string]any) *providerModelTier {
	t := &providerModelTier{original: source, fields: map[string]*core.Signal[string]{}}
	for _, key := range []string{"inputTokensAbove", "input", "output", "cacheRead", "cacheWrite"} {
		value := ""
		if key != "inputTokensAbove" {
			price := 0.0
			if h := a.providerManagerState(); h.modelAdvanced != nil {
				for _, m := range a.providerModels {
					if m.ID == h.modelAdvanced.id {
						switch key {
						case "input":
							price = m.Cost.Input
						case "output":
							price = m.Cost.Output
						case "cacheRead":
							price = m.Cost.CacheRead
						case "cacheWrite":
							price = m.Cost.CacheWrite
						}
						break
					}
				}
			}
			value = strconv.FormatFloat(price, 'f', -1, 64)
		}
		if v, ok := source[key].(float64); ok {
			value = strconv.FormatFloat(v, 'f', -1, 64)
		}
		t.fields[key] = core.NewSignal(a.cx, value)
	}
	return t
}
func (a *app) providerModelAdvancedPanel(cx *core.Scope) core.Node {
	h := a.providerManagerState()
	f := h.modelAdvanced
	colors := ui.ColorsOf(cx)
	if f == nil {
		return core.View{}
	}
	return core.Dynamic(func(cx *core.Scope) core.Node {
		_ = f.rev.Get()
		if f.loading.Get() {
			return ui.Text(apptext.T("正在读取模型高级设置…"), 12, ui.Regular, colors.Muted)
		}
		if !f.loaded {
			return core.Text{ContentFunc: f.problem.Get, TestID: "provider-model-advanced-error", Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Danger)}
		}
		dirty := func() { f.dirty.Set(true); h.modelDirty.Set(true) }
		nodes := []core.Node{ui.Text(apptext.T("模型高级设置：%s", f.id), 14, ui.Semibold, colors.Text), ui.Text(apptext.T("这些选项只影响当前模型；通常保持默认即可。"), 11, ui.Regular, colors.Muted), core.Text{ContentFunc: f.problem.Get, TestID: "provider-model-advanced-error", Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Danger)},
			providerFormField("模型 User-Agent", "留空继承供应商请求头。", ui.Input{Value: f.agent.Get, OnChange: func(v string) { f.agent.Set(v); dirty() }, Label: apptext.T("模型 User-Agent"), TestID: "provider-model-user-agent", Disabled: h.busy.Get}),
			providerFormField("默认思考档位", "该模型新会话使用的档位；留空继承全局设置。", ui.Select[string]{Options: thinkingLevelOptions(f.thinking.Get()), Value: f.thinking.Get, OnChange: func(v string) { f.thinking.Set(v); dirty() }, TestID: "provider-model-thinking-default", Label: apptext.T("默认思考档位"), Style: core.Style{Width: core.Pct(100)}, Disabled: h.busy.Get}),
			ui.Text(apptext.T("允许的思考档位"), 12, ui.Medium, colors.Text), ui.Text(apptext.T("只有供应商实际支持时才开启扩展档位；已有自定义映射会保留。"), 11, ui.Regular, colors.Muted),
		}
		for _, entry := range managedThinkingLevels {
			level := entry
			value, exists := f.cfg.ThinkingLevelMap[level]
			enabled := (!exists && level != "xhigh" && level != "max") || value != nil && exists
			nodes = append(nodes, ui.Checkbox{Text: level, TestID: "provider-model-thinking-" + level, Checked: func() bool { return enabled }, Disabled: h.busy.Get, OnChange: func(on bool) {
				if on {
					if _, ok := f.cfg.ThinkingLevelMap[level].(string); !ok {
						if level == "xhigh" || level == "max" {
							f.cfg.ThinkingLevelMap[level] = level
						} else {
							delete(f.cfg.ThinkingLevelMap, level)
						}
					}
				} else {
					if level == "xhigh" || level == "max" {
						delete(f.cfg.ThinkingLevelMap, level)
					} else {
						f.cfg.ThinkingLevelMap[level] = nil
					}
				}
				dirty()
				f.rev.Update(func(n int) int { return n + 1 })
			}})
		}
		nodes = append(nodes, setDivider(), ui.Text(apptext.T("阶梯价格"), 12, ui.Medium, colors.Text), ui.Text(apptext.T("上下文超过阈值后使用该档价格；阈值按 tokens 递增，价格单位为美元 / 百万 tokens。"), 11, ui.Regular, colors.Muted))
		for index, tier := range f.tiers {
			i, t := index, tier
			fields := []core.Node{ui.Text(apptext.T("价格档位 %d", i+1), 12, ui.Medium, colors.Text)}
			for j, key := range []string{"inputTokensAbove", "input", "output", "cacheRead", "cacheWrite"} {
				label := []string{"输入 tokens 阈值", "输入价格", "输出价格", "缓存读取价格", "缓存写入价格"}[j]
				sig := t.fields[key]
				fields = append(fields, providerFormField(label, "", ui.Input{Value: sig.Get, OnChange: func(v string) { sig.Set(v); dirty() }, Label: apptext.T(label), TestID: "provider-model-tier-" + strconv.Itoa(i) + "-" + key, Disabled: h.busy.Get}))
			}
			fields = append(fields, ui.Button{Text: apptext.T("移除此价格档位"), TestID: "provider-model-tier-remove-" + strconv.Itoa(i), Size: ui.SizeSmall, Variant: ui.ButtonGhost, Disabled: h.busy.Get, OnPress: func() {
				f.tiers = append(f.tiers[:i], f.tiers[i+1:]...)
				dirty()
				f.rev.Update(func(n int) int { return n + 1 })
			}})
			nodes = append(nodes, core.View{Style: core.Style{Gap: 10}, Children: fields})
		}
		nodes = append(nodes, ui.Button{Text: apptext.T("添加价格档位"), Size: ui.SizeSmall, TestID: "provider-model-tier-add", Disabled: h.busy.Get, OnPress: func() {
			f.tiers = append(f.tiers, a.newProviderModelTier(nil))
			dirty()
			f.rev.Update(func(n int) int { return n + 1 })
		}})
		return core.View{Style: core.Style{Gap: 12}, Children: nodes}
	})
}
func thinkingLevelOptions(current string) []ui.Option[string] {
	out := []ui.Option[string]{{Value: "", Label: apptext.T("继承全局设置")}}
	known := current == ""
	for _, v := range managedThinkingLevels {
		out = append(out, ui.Option[string]{Value: v, Label: v})
		known = known || v == current
	}
	if !known {
		out = append(out, ui.Option[string]{Value: current, Label: current})
	}
	return out
}
func (a *app) saveProviderModelAdvanced() {
	h := a.providerManagerState()
	f := h.modelAdvanced
	if f == nil || !f.loaded || f.loading.GetUntracked() || h.busy.GetUntracked() {
		return
	}
	cfg := f.cfg
	cfg.UserAgent = strings.TrimSpace(f.agent.GetUntracked())
	cfg.Tiers = nil
	for _, t := range f.tiers {
		tier := map[string]any{}
		for k, v := range t.original {
			tier[k] = v
		}
		for k, sig := range t.fields {
			value := strings.TrimSpace(sig.GetUntracked())
			if value == "" {
				if k == "inputTokensAbove" {
					f.problem.Set(apptext.T("请填写每个价格档位的输入 tokens 阈值。"))
					return
				}
				delete(tier, k)
				continue
			}
			v, err := strconv.ParseFloat(value, 64)
			if err != nil {
				f.problem.Set(apptext.T("价格与阈值必须是有效数字。"))
				return
			}
			tier[k] = v
		}
		cfg.Tiers = append(cfg.Tiers, tier)
	}
	provider, seq, thinking := a.providerID.GetUntracked(), h.loadSeq, f.thinking.GetUntracked()
	h.busy.Set(true)
	f.problem.Set("")
	go func() {
		err := writeModelAdvanced(provider, f.id, cfg)
		if err == nil {
			if e := saveModelThinkingDefault(provider, f.id, thinking); e != nil {
				err = errors.New(apptext.T("模型高级配置已保存，但默认思考档位保存失败：%s", e.Error()))
			}
		}
		a.cx.Post(func() {
			if seq != h.loadSeq {
				return
			}
			h.busy.Set(false)
			if err != nil {
				f.problem.Set(err.Error())
				return
			}
			h.modelDirty.Set(false)
			h.modelAdvancedOpen.Set(false)
			a.refreshProviders()
			a.toast(ui.ToastSuccess, "模型高级设置已保存", f.id)
		})
	}()
}
func (a *app) resetManagedModel(id string) {
	provider := a.providerID.GetUntracked()
	a.askConfirm(apptext.T("恢复模型默认值？"), apptext.T("将从 pi 模型目录恢复 %s 的能力、价格和兼容性配置。", id), apptext.T("恢复默认"), func() {
		a.runProviderModelMutation(provider, "模型默认值已恢复", func() error { return resetProviderModel(provider, id) })
	})
}
