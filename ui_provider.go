package main

// The provider editor: the fields of one entry in pi's models.json, a
// connection test, and a way into the raw files. Only the three fields
// the app understands are written back; everything else in the file is
// kept as it was.

import (
	"path/filepath"
	"strconv"
	"strings"

	"github.com/oneo-me/nsgo/base"
	"github.com/oneo-me/nsgo/core"
	"github.com/oneo-me/nsgo/icons/lucide"
	"github.com/oneo-me/nsgo/ui"
)

// openProviderDialog shows one provider's fields.
func (a *app) openProviderDialog(id string) {
	if a.providerOpen == nil {
		return
	}
	a.providerID.Set(id)
	a.providerAPI.Set("")
	a.providerBase.Set("")
	a.providerKeySig.Set("")
	a.providerModels = nil
	a.providerTest.Set("")
	for _, cfg := range readProviderConfigs() {
		if cfg.ID != id {
			continue
		}
		a.providerAPI.Set(cfg.API)
		a.providerBase.Set(cfg.BaseURL)
		a.providerKeySig.Set(cfg.APIKey)
		a.providerModels = cfg.Models
		break
	}
	a.providerOpen.Set(true)
}

// saveProvider writes the dialog's fields back to models.json.
func (a *app) saveProvider() {
	id := a.providerID.GetUntracked()
	err := saveProviderConfig(id, a.providerAPI.GetUntracked(), a.providerBase.GetUntracked(), a.providerKeySig.GetUntracked())
	if err != nil {
		a.toast(ui.ToastError, "保存失败", err.Error())
		return
	}
	a.providerOpen.Set(false)
	a.toast(ui.ToastSuccess, "已保存 "+id, "重启 Agent 后生效。")
	a.refreshProviders()
}

// testProvider checks the dialog's current fields, before saving.
func (a *app) testProvider() {
	cfg := providerConfig{
		ID:      a.providerID.GetUntracked(),
		API:     a.providerAPI.GetUntracked(),
		BaseURL: a.providerBase.GetUntracked(),
		APIKey:  a.providerKeySig.GetUntracked(),
		Models:  a.providerModels,
	}
	a.providerTest.Set("正在测试…")
	go func() {
		msg, err := testProviderConnection(cfg)
		a.cx.Post(func() {
			if err != nil {
				a.providerTest.Set("失败：" + err.Error())
				return
			}
			a.providerTest.Set(msg)
		})
	}()
}

// refreshProviders reads models.json again and probes auth in the
// background.
func (a *app) refreshProviders() {
	go func() {
		list := readProviders()
		probed := probeProviders(a.piPath(), list)
		a.cx.Post(func() { a.providers.Set(probed) })
	}()
}

// openPiConfigFile opens one of pi's own config files in the editor.
func (a *app) openPiConfigFile(name string) {
	dir := piConfigDir()
	if dir == "" {
		a.toast(ui.ToastError, "找不到 pi 的配置目录", "")
		return
	}
	a.settings.Set(false)
	a.providerOpen.Set(false)
	a.openEditorFile(dir, filepath.Join(dir, name))
}

// providerDialog edits one provider.
func (a *app) providerDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		fieldStyle := core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 9), CornerRadius: 7,
			Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(),
			Color: colors.Text(), FontSize: 12, FontFamily: ui.Mono}
		field := func(label, hint string, input core.Node) core.Node {
			return core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					ui.Text(label, 10.5, ui.Medium, colors.Muted),
					core.Text{Content: hint, Style: core.Style{FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
				}},
				input,
			}}
		}
		var modelRows []core.Node
		for _, m := range a.providerModels {
			name := m.Name
			if name == "" {
				name = m.ID
			}
			meta := ""
			if m.ContextWindow > 0 {
				meta = tokens(m.ContextWindow) + " 上下文"
			}
			if m.Reasoning {
				if meta != "" {
					meta += " · "
				}
				meta += "推理"
			}
			modelRows = append(modelRows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8,
				MinHeight: core.Pt(24)}, Children: []core.Node{
				ui.Icon(lucide.Cpu, 11, colors.Faint),
				core.Text{Content: name, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
					Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11.5}, StyleFunc: ui.Colored(colors.Text)},
				core.Text{Content: meta, Style: core.Style{FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
			}})
		}
		if len(modelRows) == 0 {
			modelRows = append(modelRows, core.Text{Content: "这个供应商还没有模型条目。",
				Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Faint)})
		}
		status := a.providerTest.Get()
		statusColor := colors.Up
		if strings.HasPrefix(status, "失败") {
			statusColor = colors.Danger
		}
		return ui.Dialog{
			Open:         a.providerOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.providerOpen.Set(open) },
			Title:        "配置 " + a.providerID.Get(),
			TestID:       "provider-dialog",
			Style:        core.Style{Width: core.Pt(580), MaxHeight: core.Pt(620)},
			Children: []core.Node{core.Scroll{Style: core.Style{MaxHeight: core.Pt(470)}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 12, Padding: core.Edges{Right: 6}}, Children: []core.Node{
					field("API", "pi 的适配器名", core.Input{
						Value: a.providerAPI.Get, OnChange: a.providerAPI.Set,
						Placeholder: "openai-completions / anthropic-messages", Label: "API", TestID: "provider-api",
						Style: fieldStyle,
					}),
					field("Base URL", "请求发到的地方", core.Input{
						Value: a.providerBase.Get, OnChange: a.providerBase.Set,
						Placeholder: "https://api.example.com/v1", Label: "Base URL", TestID: "provider-base",
						Style: fieldStyle,
					}),
					field("API Key", "可以写 $环境变量", core.Input{
						Value: a.providerKeySig.Get, OnChange: a.providerKeySig.Set, Masked: true,
						Placeholder: "sk-… 或 $MY_API_KEY", Label: "API Key", TestID: "provider-key",
						Style: fieldStyle,
					}),
					core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
						core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
							ui.Text("模型", 10.5, ui.Medium, colors.Muted),
							ui.Text(strconv.Itoa(len(a.providerModels)), 10, ui.Regular, colors.Faint),
						}},
						core.View{Style: core.Style{Gap: 1}, Children: modelRows},
					}},
					core.Show{When: func() bool { return a.providerTest.Get() != "" }, Then: func(*core.Scope) core.Node {
						return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7}, Children: []core.Node{
							ui.Icon(lucide.Activity, 12, func() core.Color { return statusColor() }),
							core.Text{ContentFunc: func() string { return a.providerTest.Get() }, MaxLines: 3,
								Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(statusColor)},
						}}
					}},
					core.Text{Content: "只写回 api、baseUrl、apiKey 三个字段；models、compat 等保持原样。保存后重启 Agent 生效。",
						Style: core.Style{FontSize: 10.5, LineHeight: 16}, StyleFunc: ui.Colored(colors.Faint)},
				}},
			}}},
			Footer: []core.Node{
				ui.Button{Text: "编辑原始 JSON", Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
					a.openPiConfigFile("models.json")
				}},
				core.View{Style: core.Style{FlexGrow: 1}},
				ui.Button{Text: "测试连接", Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "provider-test",
					OnPress: func() { a.testProvider() }},
				ui.Button{Text: "取消", Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.providerOpen.Set(false) }},
				ui.Button{Text: "保存", Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "provider-save",
					OnPress: func() { a.saveProvider() }},
			},
		}
	})
}
