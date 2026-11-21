//go:build !js && !android && !ios

package workbench

import (
	"errors"
	"net/url"
	"strings"
	"unicode"

	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// providerCreateDialog collects a provider and its first model in one save.
func (a *app) providerCreateDialog(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	id, api, endpoint := core.NewSignal(cx, ""), core.NewSignal(cx, "openai-completions"), core.NewSignal(cx, "")
	key, model := core.NewSignal(cx, ""), core.NewSignal(cx, "")
	problem, saving := core.NewSignal(cx, ""), core.NewSignal(cx, false)
	field := func(label, placeholder, testID string, value *core.Signal[string], masked, focus bool) core.Node {
		return core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
			ui.Text(label, 12, ui.Medium, colors.Text),
			ui.Input{Label: label, Placeholder: placeholder, TestID: testID, Value: value.Get, OnChange: value.Set,
				Disabled: saving.Get, Masked: masked, AutoFocus: focus},
		}}
	}
	reset := func() {
		id.Set("")
		api.Set("openai-completions")
		endpoint.Set("")
		key.Set("")
		model.Set("")
		problem.Set("")
	}
	save := func() {
		name, adapter, baseURL, modelID := strings.TrimSpace(id.GetUntracked()), strings.TrimSpace(api.GetUntracked()),
			strings.TrimSpace(endpoint.GetUntracked()), strings.TrimSpace(model.GetUntracked())
		if name == "" || adapter == "" || modelID == "" {
			problem.Set(apptext.T("请填写供应商 ID、API 和模型 ID。"))
			return
		}
		if strings.ContainsAny(name, `/\`) || strings.ContainsFunc(name, unicode.IsSpace) {
			problem.Set(apptext.T("供应商 ID 不能包含空白或斜杠。"))
			return
		}
		u, err := url.ParseRequestURI(baseURL)
		if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
			problem.Set(apptext.T("请输入有效的 HTTP 或 HTTPS 地址。"))
			return
		}
		if _, found := a.providerInfoOf(name); found {
			problem.Set(apptext.T("供应商 ID 已存在。请打开现有供应商进行配置。"))
			return
		}
		problem.Set("")
		saving.Set(true)
		cfg := providerConfig{ID: name, API: adapter, BaseURL: baseURL, APIKey: strings.TrimSpace(key.GetUntracked()),
			Models: []modelConfig{{ID: modelID}}}
		go func() {
			err := writeProviderConfig(cfg, true)
			cx.Post(func() {
				saving.Set(false)
				if errors.Is(err, errProviderExists) {
					problem.Set(apptext.T("供应商 ID 已存在。请打开现有供应商进行配置。"))
					return
				}
				if err != nil {
					problem.Set(apptext.T("保存失败") + "\n" + err.Error())
					return
				}
				a.providerQuery.Set("")
				a.providerOpen.Set(false)
				reset()
				a.refreshProviders()
				a.toast(ui.ToastSuccess, apptext.T("已添加供应商"), apptext.T("重启 Agent 后生效。"))
			})
		}()
	}
	return ui.Dialog{Title: apptext.T("添加供应商"), TestID: "provider-add-dialog", Open: a.providerOpen.Get,
		OnOpenChange: func(open bool, _ base.Reason) {
			if !saving.GetUntracked() {
				a.providerOpen.Set(open)
			}
		},
		OnClose: func() {
			if !saving.GetUntracked() {
				reset()
			}
		},
		Children: []core.Node{
			field(apptext.T("供应商 ID"), "my-provider", "provider-add-id", id, false, true),
			field("API", "openai-completions", "provider-add-api", api, false, false),
			field("Base URL", "https://api.example.com/v1", "provider-add-base", endpoint, false, false),
			field("API Key", apptext.T("sk-… 或 $MY_API_KEY"), "provider-add-key", key, true, false),
			field(apptext.T("模型 ID"), "gpt-4o-mini", "provider-add-model", model, false, false),
			core.Show{When: func() bool { return problem.Get() != "" }, Then: func(*core.Scope) core.Node {
				return core.Text{ContentFunc: problem.Get, TestID: "provider-add-error", Style: ui.TypeBody, StyleFunc: ui.Colored(colors.Danger)}
			}},
		},
		Footer: []core.Node{
			ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, TestID: "provider-add-cancel", Disabled: saving.Get,
				OnPress: func() { a.providerOpen.Set(false) }},
			ui.Button{Text: apptext.T("保存"), Variant: ui.ButtonPrimary, TestID: "provider-add-save", Disabled: saving.Get, OnPress: save},
		},
	}
}
