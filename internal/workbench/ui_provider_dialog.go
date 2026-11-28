//go:build !js && !android && !ios

package workbench

import (
	"strings"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) providerDialog() core.Node {
	h := a.providerManagerState()
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		if h.transfer.Get() != "" {
			return a.providerTransferDialog(cx)
		}
		id := a.providerID.Get()
		seq := h.loadSeq
		loading := h.loading.Get()
		if id == "" {
			return a.providerCreateDialog(cx)
		}
		var content core.Node
		if loading {
			content = ui.Text(apptext.T("正在读取供应商配置…"), 12, ui.Regular, colors.Muted)
		} else {
			switch h.tab.Get() {
			case "models":
				content = a.providerModelsPanel(cx)
			case "usage":
				content = a.providerUsagePanel(cx)
			default:
				content = a.providerConnectionPanel(cx)
			}
		}
		return ui.Dialog{Open: a.providerOpen.Get, OnOpenChange: func(open bool, _ base.Reason) {
			if !open && h.loadSeq == seq && h.transfer.GetUntracked() == "" && a.providerID.GetUntracked() == id {
				a.closeProviderManager()
			}
		}, TestID: "provider-dialog",
			Style: core.Style{Width: core.Pct(90), MaxWidth: core.Pt(800), Height: core.Pt(680), MaxHeight: core.Pct(92), Gap: 12}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 4}, Children: []core.Node{ui.Text(id, 17, ui.Semibold, colors.Text), ui.Text(apptext.T("配置连接后添加模型，再按需开启用量查询。"), 11, ui.Regular, colors.Muted)}},
				ui.Tabs[string]{Variant: ui.TabsUnderline, Size: ui.SizeSmall, Label: apptext.T("供应商管理"), TestID: "provider-tabs", Value: h.tab.Get, OnChange: func(value string) {
					if h.busy.GetUntracked() {
						return
					}
					if h.usage != nil && h.usage.refreshTimer != nil {
						h.usage.refreshTimer.Stop()
					}
					h.problem.Set("")
					h.tab.Set(value)
				}, Options: []ui.Option[string]{
					{Value: "connection", Label: apptext.T("连接设置"), TestID: "provider-tab-connection"}, {Value: "models", Label: apptext.T("模型管理"), TestID: "provider-tab-models"}, {Value: "usage", Label: apptext.T("用量查询"), TestID: "provider-tab-usage"},
				}},
				core.Scroll{TestID: "provider-scroll", Style: ui.FillRest.Merge(core.Style{MinHeight: core.Pt(0)}), Children: []core.Node{core.View{Style: core.Style{Gap: 14, Padding: core.Edges{Right: scrollbarGutter, Bottom: 12}}, Children: []core.Node{content}}}},
				core.Text{ContentFunc: h.problem.Get, TestID: "provider-error", Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Danger)},
				a.providerDialogFooter(cx),
			}}
	})
}

func providerFormField(label, help string, input core.Node) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		nodes := []core.Node{core.Text{Content: apptext.T(label), Style: core.Style{FontSize: 12, FontWeight: ui.Medium}}, input}
		if help != "" {
			nodes = append(nodes, core.Text{Content: apptext.T(help), Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(ui.ColorsOf(cx).Muted)})
		}
		return core.View{Style: core.Style{Gap: 5}, Children: nodes}
	})
}

func (a *app) providerConnectionPanel(cx *core.Scope) core.Node {
	h := a.providerManagerState()
	colors := ui.ColorsOf(cx)
	input := func(label, id string, value *core.Signal[string], masked bool) core.Node {
		return ui.Input{Value: value.Get, OnChange: func(s string) { value.Set(s); h.dirty.Set(true) }, Label: apptext.T(label), Masked: masked, TestID: id, Disabled: h.busy.Get}
	}
	return core.View{Style: core.Style{Gap: 14}, Children: []core.Node{
		providerFormField("接口协议", "与供应商文档中的接口保持一致；不确定时先选 OpenAI Chat Completions。", ui.Select[string]{Label: apptext.T("接口协议"), TestID: "provider-api", Value: a.providerAPI.Get, OnChange: func(s string) { a.providerAPI.Set(s); h.dirty.Set(true) }, OptionsFunc: func() []ui.Option[string] { return providerAPIOptions(a.providerAPI.Get()) }, Searchable: true, Disabled: h.busy.Get, Style: core.Style{Width: core.Pct(100)}}),
		providerFormField("接口地址（Base URL）", "填写 API 根地址，例如 https://api.example.com/v1，不要填写聊天接口完整路径。", input("接口地址", "provider-base", a.providerBase, false)),
		providerFormField("API Key", "可填密钥、环境变量名，或以 ! 开头的命令；留空时沿用 pi 的登录凭据。", input("API Key", "provider-key", a.providerKeySig, true)),
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
			ui.Button{Text: apptext.T("测试连接"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "provider-test", OnPress: a.testProvider, Disabled: func() bool { return h.loading.Get() || h.testBusy.Get() }},
			core.Text{ContentFunc: a.providerTest.Get, TestID: "provider-test-result", Style: core.Style{FontSize: 11, FlexShrink: 1, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Muted)},
		}},
		ui.Checkbox{Text: apptext.T("显示高级连接选项"), TestID: "provider-advanced", Checked: h.advanced.Get, OnChange: h.advanced.Set},
		core.Show{When: h.advanced.Get, Then: func(cx *core.Scope) core.Node {
			return core.View{Style: core.Style{Gap: 14}, Children: []core.Node{
				providerFormField("自定义请求头（JSON）", "通常留空；可按供应商要求配置 User-Agent 等请求头。不要添加换行。", ui.Input{Value: h.headers.Get, OnChange: func(s string) { h.headers.Set(s); h.dirty.Set(true) }, Label: apptext.T("自定义请求头"), TestID: "provider-headers", Multiline: true, Style: core.Style{Height: core.Pt(92)}}),
				core.Text{Content: apptext.T("供应商级兼容性：默认继承 pi 判断；仅在供应商文档要求时覆盖。"), Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
				a.providerCompatFields(),
				a.providerRenameFields(),
			}}
		}},
	}}
}

func providerAPIOptions(current string) []ui.Option[string] {
	options := []ui.Option[string]{
		{Value: "openai-completions", Label: "OpenAI Chat Completions"}, {Value: "openai-responses", Label: "OpenAI Responses"}, {Value: "anthropic-messages", Label: "Anthropic Messages"}, {Value: "google-generative-ai", Label: "Google Gemini"}, {Value: "google-gemini-cli", Label: "Google Gemini CLI"}, {Value: "google-vertex", Label: "Google Vertex AI"}, {Value: "azure-openai-responses", Label: "Azure OpenAI Responses"}, {Value: "amazon-bedrock", Label: "Amazon Bedrock"}, {Value: "openai-codex-responses", Label: "OpenAI Codex Responses"},
	}
	if current == "" {
		options = append([]ui.Option[string]{{Value: "", Label: apptext.T("继承内置配置")}}, options...)
	} else {
		found := false
		for _, o := range options {
			if o.Value == current {
				found = true
				break
			}
		}
		if !found {
			options = append(options, ui.Option[string]{Value: current, Label: current})
		}
	}
	return options
}

func (a *app) providerCompatFields() core.Node {
	h := a.providerManagerState()
	return compatibilityFields("provider-compat-", h.compatRev, func() map[string]bool { return h.compat }, func(flag, mode string) {
		if h.compat == nil {
			h.compat = map[string]bool{}
		}
		if mode == "" {
			delete(h.compat, flag)
		} else {
			h.compat[flag] = mode == "on"
		}
		h.dirty.Set(true)
	})
}

func (a *app) providerDialogFooter(cx *core.Scope) core.Node {
	h := a.providerManagerState()
	colors := ui.ColorsOf(cx)
	tab := h.tab.Get()
	actions := []core.Node{ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, TestID: "provider-cancel", OnPress: a.closeProviderManager, Disabled: h.busy.Get}, core.Text{ContentFunc: func() string {
		if h.busy.Get() {
			return apptext.T("正在保存…")
		}
		if h.dirty.Get() || h.modelDirty.Get() || (h.usage != nil && h.usage.dirty.Get()) {
			return apptext.T("有未保存的更改")
		}
		return ""
	}, Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Muted)}, core.View{Style: core.Style{FlexGrow: 1}}}
	if tab == "connection" {
		actions = append(actions, ui.Button{Text: apptext.T("保存连接"), Variant: ui.ButtonPrimary, TestID: "provider-save", Disabled: func() bool { return h.loading.Get() || h.busy.Get() }, OnPress: a.saveProvider})
	}
	if tab == "models" && h.modelAdvancedOpen.Get() {
		actions = append(actions, ui.Button{Text: apptext.T("返回模型列表"), TestID: "provider-model-advanced-cancel", Disabled: h.busy.Get, OnPress: func() {
			close := func() { h.modelAdvancedOpen.Set(false); h.modelDirty.Set(false) }
			if h.modelDirty.GetUntracked() {
				a.askConfirmPrimary(apptext.T("放弃模型更改？"), apptext.T("当前模型尚未保存。"), apptext.T("放弃更改"), close)
			} else {
				close()
			}
		}}, ui.Button{Text: apptext.T("保存高级设置"), Variant: ui.ButtonPrimary, TestID: "provider-model-advanced-save", Disabled: h.busy.Get, OnPress: a.saveProviderModelAdvanced})
	}
	if tab == "models" && h.modelForm.Get() && !h.modelAdvancedOpen.Get() {
		actions = append(actions, ui.Button{Text: apptext.T("返回模型列表"), Variant: ui.ButtonSecondary, TestID: "provider-model-cancel", Disabled: h.busy.Get, OnPress: a.cancelProviderModel}, ui.Button{Text: apptext.T("保存模型"), Variant: ui.ButtonPrimary, TestID: "provider-model-save", Disabled: h.busy.Get, OnPress: a.saveProviderModel})
	}
	if tab == "usage" {
		actions = append(actions, ui.Button{Text: apptext.T("保存用量配置"), Variant: ui.ButtonPrimary, TestID: "provider-usage-save", Disabled: func() bool { return h.loading.Get() || h.busy.Get() || h.usage == nil }, OnPress: a.saveProviderUsage})
	}
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: actions}
}

func providerLabel(api string) string {
	for _, o := range providerAPIOptions(api) {
		if o.Value == api {
			return o.Label
		}
	}
	return strings.TrimSpace(api)
}
