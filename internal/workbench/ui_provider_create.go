//go:build !js && !android && !ios

package workbench

import (
	"errors"
	"strings"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// A new connection needs a name, an endpoint and credentials. The first model
// is optional because many users discover its exact ID from the server.
func (a *app) providerCreateDialog(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	manager := a.providerManagerState()
	id, api, endpoint, key, model := core.NewSignal(cx, ""), core.NewSignal(cx, "openai-completions"), core.NewSignal(cx, ""), core.NewSignal(cx, ""), core.NewSignal(cx, "")
	preset, problem, saving, dirty := core.NewSignal(cx, ""), core.NewSignal(cx, ""), core.NewSignal(cx, false), core.NewSignal(cx, false)
	field := func(label, help, testID string, value *core.Signal[string], masked, focus bool) core.Node {
		return providerFormField(label, help, ui.Input{Label: apptext.T(label), TestID: testID, Value: value.Get, OnChange: func(v string) { value.Set(v); dirty.Set(true) }, Disabled: saving.Get, Masked: masked, AutoFocus: focus})
	}
	close := func() {
		if manager.transfer.GetUntracked() != "" || a.providerID.GetUntracked() != "" {
			return
		}
		if saving.GetUntracked() {
			return
		}
		done := func() {
			a.providerOpen.Set(false)
			id.Set("")
			api.Set("openai-completions")
			endpoint.Set("")
			key.Set("")
			model.Set("")
			preset.Set("")
			problem.Set("")
			dirty.Set(false)
		}
		if dirty.GetUntracked() {
			a.askConfirmPrimary(apptext.T("放弃添加供应商？"), apptext.T("填写的连接信息尚未保存。"), apptext.T("放弃更改"), done)
		} else {
			done()
		}
	}
	save := func() {
		if saving.GetUntracked() {
			return
		}
		cfg := providerConfig{ID: strings.TrimSpace(id.GetUntracked()), API: strings.TrimSpace(api.GetUntracked()), BaseURL: strings.TrimSpace(endpoint.GetUntracked()), APIKey: strings.TrimSpace(key.GetUntracked())}
		if cfg.ID == "" || cfg.API == "" {
			problem.Set(apptext.T("请填写供应商 ID 和 API。"))
			return
		}
		if !validProviderID(cfg.ID) {
			problem.Set(apptext.T("供应商 ID 只能包含英文字母、数字、点、短横线和下划线。"))
			return
		}
		if _, err := providerModelEndpoints(cfg.BaseURL, cfg.API, ""); err != nil {
			problem.Set(apptext.T("请输入有效的 HTTP 或 HTTPS 地址。"))
			return
		}
		if existing, found := a.providerInfoOf(cfg.ID); found && existing.Configured {
			problem.Set(apptext.T("供应商 ID 已存在。请打开现有供应商进行配置。"))
			return
		}
		if modelID := strings.TrimSpace(model.GetUntracked()); modelID != "" {
			cfg.Models = []modelConfig{{ID: modelID}}
		}
		saving.Set(true)
		problem.Set("")
		go func() {
			err := writeProviderConfig(cfg, true)
			a.cx.Post(func() {
				saving.Set(false)
				if errors.Is(err, errProviderExists) {
					problem.Set(apptext.T("供应商 ID 已存在。请打开现有供应商进行配置。"))
					return
				}
				if err != nil {
					problem.Set(apptext.T("保存失败") + "\n" + err.Error())
					return
				}
				dirty.Set(false)
				key.Set("")
				a.providerQuery.Set("")
				a.refreshProviders()
				a.openProviderSection(cfg.ID, "models", nil)
				a.toast(ui.ToastSuccess, "供应商已添加", "接下来获取模型列表，或手动添加模型。")
			})
		}()
	}
	return ui.Dialog{Title: apptext.T("添加供应商"), TestID: "provider-add-dialog", Open: a.providerOpen.Get, OnOpenChange: func(open bool, _ base.Reason) {
		if !open {
			close()
		}
	}, Style: core.Style{Width: core.Pct(90), MaxWidth: core.Pt(720), MaxHeight: core.Pct(92)}, Children: []core.Node{
		core.Scroll{TestID: "provider-add-scroll", Style: core.Style{MaxHeight: core.Pt(530)}, Children: []core.Node{core.View{Style: core.Style{Gap: 13, Padding: core.Edges{Right: scrollbarGutter, Bottom: 10}}, Children: []core.Node{
			ui.Text(apptext.T("先填写连接信息，保存后继续管理模型和用量。"), 11, ui.Regular, colors.Muted),
			providerFormField("供应商类型", "自定义中转选择 OpenAI 兼容接口；也可以使用 pi 内置供应商的地址和协议。", ui.Select[string]{Label: apptext.T("供应商类型"), TestID: "provider-add-preset", Value: preset.Get, OnChange: func(v string) {
				preset.Set(v)
				if v == "" {
					return
				}
				if p, ok := a.providerInfoOf(v); ok {
					id.Set(v)
					api.Set(p.API)
					endpoint.Set(p.BaseURL)
					dirty.Set(true)
				}
			}, Searchable: true, OptionsFunc: func() []ui.Option[string] {
				options := []ui.Option[string]{{Value: "", Label: apptext.T("自定义 / OpenAI 兼容")}}
				for _, p := range a.providers.Get() {
					if p.Builtin && !p.Configured {
						options = append(options, ui.Option[string]{Value: p.ID, Label: p.ID})
					}
				}
				return options
			}, Style: core.Style{Width: core.Pct(100)}}),
			field("供应商 ID", "例如 my-provider；用于区分连接，只能使用英文、数字、点、短横线和下划线。", "provider-add-id", id, false, true),
			providerFormField("接口协议", "一般中转使用 OpenAI Chat Completions；请以供应商文档为准。", ui.Select[string]{Label: apptext.T("接口协议"), TestID: "provider-add-api", OptionsFunc: func() []ui.Option[string] { return providerAPIOptions(api.Get()) }, Value: api.Get, OnChange: func(v string) { api.Set(v); dirty.Set(true) }, Style: core.Style{Width: core.Pct(100)}}),
			field("接口地址（Base URL）", "例如 https://api.example.com/v1，填写 API 根地址。", "provider-add-base", endpoint, false, false),
			field("API Key", "可填写密钥或环境变量名；OAuth 登录用户可留空，到“登录与密钥”完成登录。", "provider-add-key", key, true, false),
			field("首个模型 ID（可选）", "不确定模型 ID 时留空，保存后从供应商获取列表。", "provider-add-model", model, false, false),
			core.Text{ContentFunc: problem.Get, TestID: "provider-add-error", Style: ui.TypeBody, StyleFunc: ui.Colored(colors.Danger)},
		}}}},
	}, Footer: []core.Node{
		ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, TestID: "provider-add-cancel", Disabled: saving.Get, OnPress: close},
		ui.Button{Text: apptext.T("添加并管理模型"), Variant: ui.ButtonPrimary, TestID: "provider-add-save", Disabled: saving.Get, OnPress: save},
	}}
}
