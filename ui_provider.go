package main

// The provider editor: the fields of one entry in pi's models.json, a
// connection test, and a way into the raw files. Only the three fields
// the app understands are written back; everything else in the file is
// kept as it was.

import (
	"path/filepath"
	"strconv"
	"strings"

	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
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
	a.providerBalance.Set("")
	spec := a.cfg.Balances[id]
	a.providerBalURL.Set(spec.URL)
	a.providerBalPath.Set(spec.Path)
	a.providerBalCur.Set(spec.Currency)
	a.resetModelForm()
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
	spec := balanceSpec{
		URL:      strings.TrimSpace(a.providerBalURL.GetUntracked()),
		Path:     strings.TrimSpace(a.providerBalPath.GetUntracked()),
		Currency: strings.TrimSpace(a.providerBalCur.GetUntracked()),
	}
	if a.st != nil {
		a.st.edit(func(c *config) {
			if spec.URL == "" && spec.Path == "" && spec.Currency == "" {
				delete(c.Balances, id)
				return
			}
			if c.Balances == nil {
				c.Balances = map[string]balanceSpec{}
			}
			c.Balances[id] = spec
		})
		a.cfg = a.st.config()
	}
	a.providerOpen.Set(false)
	a.toast(ui.ToastSuccess, "已保存 "+id, "重启 Agent 后生效。")
	a.refreshProviders()
}

// dialogBalanceSpec is the balance endpoint as the dialog reads now.
func (a *app) dialogBalanceSpec() *balanceSpec {
	spec := balanceSpec{
		URL:      strings.TrimSpace(a.providerBalURL.GetUntracked()),
		Path:     strings.TrimSpace(a.providerBalPath.GetUntracked()),
		Currency: strings.TrimSpace(a.providerBalCur.GetUntracked()),
	}
	if spec.URL == "" && spec.Path == "" && spec.Currency == "" {
		return nil
	}
	return &spec
}

// providerFromDialog is the provider as the dialog's fields read now.
func (a *app) providerFromDialog() providerConfig {
	return providerConfig{
		ID:      a.providerID.GetUntracked(),
		API:     a.providerAPI.GetUntracked(),
		BaseURL: a.providerBase.GetUntracked(),
		APIKey:  a.providerKeySig.GetUntracked(),
		Models:  a.providerModels,
	}
}

// testProvider checks the dialog's current fields, before saving.
func (a *app) testProvider() {
	cfg := a.providerFromDialog()
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

// queryProviderBalance asks the dialog's provider how much credit is left.
func (a *app) queryProviderBalance() {
	cfg := a.providerFromDialog()
	a.providerBalance.Set("正在查询…")
	spec := a.dialogBalanceSpec()
	go func() {
		msg, err := providerBalanceWith(cfg, spec)
		a.cx.Post(func() {
			if err != nil {
				a.providerBalance.Set("失败：" + err.Error())
				return
			}
			a.providerBalance.Set(msg)
		})
	}()
}

// resetModelForm clears the model editor.
func (a *app) resetModelForm() {
	a.providerModelEditing.Set("")
	a.providerModelID.Set("")
	a.providerModelName.Set("")
	a.providerModelContext.Set("")
	a.providerModelMax.Set("")
	a.providerModelReasoning.Set(false)
}

// editProviderModel loads one model into the editor.
func (a *app) editProviderModel(m modelConfig) {
	a.providerModelEditing.Set(m.ID)
	a.providerModelID.Set(m.ID)
	a.providerModelName.Set(m.Name)
	a.providerModelContext.Set(modelNumber(m.ContextWindow))
	a.providerModelMax.Set(modelNumber(m.MaxTokens))
	a.providerModelReasoning.Set(m.Reasoning)
}

// modelNumber is a positive count as text, or empty.
func modelNumber(n int) string {
	if n <= 0 {
		return ""
	}
	return strconv.Itoa(n)
}

// modelCount reads a count typed into the editor.
func modelCount(text string) int {
	n, err := strconv.Atoi(strings.TrimSpace(text))
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// saveProviderModel writes the editor's model into models.json.
func (a *app) saveProviderModel() {
	id := strings.TrimSpace(a.providerModelID.GetUntracked())
	if id == "" {
		a.toast(ui.ToastWarning, "还差模型 ID", "填一个模型名，例如 gpt-4o-mini。")
		return
	}
	editing := a.providerModelEditing.GetUntracked()
	model := modelConfig{ID: id, Name: strings.TrimSpace(a.providerModelName.GetUntracked()),
		ContextWindow: modelCount(a.providerModelContext.GetUntracked()),
		MaxTokens:     modelCount(a.providerModelMax.GetUntracked()),
		Reasoning:     a.providerModelReasoning.GetUntracked()}
	list := append([]modelConfig(nil), a.providerModels...)
	if editing != "" && editing != id {
		out := list[:0]
		for _, m := range list {
			if m.ID != editing {
				out = append(out, m)
			}
		}
		list = out
	}
	replaced := false
	for i := range list {
		if list[i].ID == id {
			list[i] = model
			replaced = true
		}
	}
	if !replaced {
		list = append(list, model)
	}
	if err := saveProviderModels(a.providerID.GetUntracked(), list); err != nil {
		a.toast(ui.ToastError, "保存模型失败", err.Error())
		return
	}
	a.providerModels = list
	a.providerModelsRev.Update(func(n int) int { return n + 1 })
	a.resetModelForm()
	a.refreshProviders()
	a.toast(ui.ToastSuccess, T("已保存模型 %s", id), T("重启 Agent 后生效。"))
}

// removeProviderModel deletes one model from models.json.
func (a *app) removeProviderModel(id string) {
	var list []modelConfig
	for _, m := range a.providerModels {
		if m.ID != id {
			list = append(list, m)
		}
	}
	if err := saveProviderModels(a.providerID.GetUntracked(), list); err != nil {
		a.toast(ui.ToastError, "删除模型失败", err.Error())
		return
	}
	a.providerModels = list
	a.providerModelsRev.Update(func(n int) int { return n + 1 })
	if a.providerModelEditing.GetUntracked() == id {
		a.resetModelForm()
	}
	a.refreshProviders()
	a.toast(ui.ToastInfo, "已删除模型", id)
}

// refreshProviders reads models.json again and probes auth in the
// background.
func (a *app) refreshProviders() {
	a.loadAuth()
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
		_ = a.providerModelsRev.Get()
		_ = a.providerModelEditing.Get()
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
				meta += T("推理")
			}
			modelRows = append(modelRows, core.View{
				OnPress: func(core.PressEvent) { a.editProviderModel(m) },
				Role:    core.RoleButton, Label: name, TestID: "provider-model-" + m.ID,
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(26),
						Padding: core.Symmetric(0, 4), CornerRadius: 5, Hover: &core.Style{Background: colors.Hover()}}
				},
				Children: []core.Node{
					ui.Icon(lucide.Cpu, 11, colors.Faint),
					core.Text{Content: name, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11.5}, StyleFunc: ui.Colored(colors.Text)},
					core.Text{Content: meta, Style: core.Style{FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
					core.View{OnPress: func(core.PressEvent) { a.removeProviderModel(m.ID) }, Role: core.RoleButton,
						Label: T("删除模型") + " " + name, TestID: "provider-model-remove-" + m.ID,
						StyleFunc: func() core.Style {
							return core.Style{Width: core.Pt(20), Height: core.Pt(20), CornerRadius: 5, AlignItems: core.AlignCenter,
								JustifyContent: core.JustifyCenter, Hover: &core.Style{Background: colors.Pressed()}}
						},
						Children: []core.Node{ui.Icon(lucide.Trash, 10, colors.Faint)}},
				},
			})
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
		balance := a.providerBalance.Get()
		balanceColor := colors.Up
		if strings.HasPrefix(balance, "失败") {
			balanceColor = colors.Danger
		}
		return ui.Dialog{
			Open:         a.providerOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.providerOpen.Set(open) },
			Title:        T("配置 ") + a.providerID.Get(),
			TestID:       "provider-dialog",
			Style:        core.Style{Width: core.Pt(580), MaxHeight: core.Pt(620)},
			Children: []core.Node{core.Scroll{TestID: "provider-scroll", Style: core.Style{MaxHeight: core.Pt(470)}, Children: []core.Node{
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
						Placeholder: T("sk-… 或 $MY_API_KEY"), Label: "API Key", TestID: "provider-key",
						Style: fieldStyle,
					}),
					field("余额接口", "可选；相对 Base URL 或完整地址", core.Input{
						Value: a.providerBalURL.Get, OnChange: a.providerBalURL.Set,
						Placeholder: T("/credits 或 https://api.example.com/credits"), Label: T("余额接口"), TestID: "provider-balance-url",
						Style: fieldStyle,
					}),
					field("余额字段", "JSON 路径，如 data.balance 或 data.0.total", core.Input{
						Value: a.providerBalPath.Get, OnChange: a.providerBalPath.Set,
						Placeholder: "balance", Label: T("余额字段"), TestID: "provider-balance-path",
						Style: fieldStyle,
					}),
					field("余额货币", "如 CNY / USD，留空只显示数字", core.Input{
						Value: a.providerBalCur.Get, OnChange: a.providerBalCur.Set,
						Placeholder: "USD", Label: T("余额货币"), TestID: "provider-balance-currency",
						Style: fieldStyle,
					}),
					core.View{Style: core.Style{Gap: 5, Margin: core.Edges{Top: 2}}, Children: []core.Node{
						core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
							ui.Text(T("添加模型"), 10.5, ui.Medium, colors.Muted),
							core.Text{Content: T("点上面一行可以修改"), Style: core.Style{FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
						}},
						core.View{Style: core.Style{Direction: core.Row, Gap: 6}, Children: []core.Node{
							core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
								core.Input{Value: a.providerModelID.Get, OnChange: a.providerModelID.Set, Placeholder: "gpt-4o-mini",
									Label: T("模型 ID"), TestID: "provider-model-id",
									Style: core.Style{Height: core.Pt(28), Padding: core.Symmetric(0, 8), CornerRadius: 6, FontSize: 11,
										FontFamily: ui.Mono, Color: colors.Text(), Background: colors.Field(),
										BorderWidth: 1, BorderColor: colors.FieldBorder()}},
							}},
							core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
								core.Input{Value: a.providerModelName.Get, OnChange: a.providerModelName.Set, Placeholder: T("显示名称，可留空"),
									Label: T("模型名称"), TestID: "provider-model-name",
									Style: core.Style{Height: core.Pt(28), Padding: core.Symmetric(0, 8), CornerRadius: 6, FontSize: 11,
										Color: colors.Text(), Background: colors.Field(),
										BorderWidth: 1, BorderColor: colors.FieldBorder()}},
							}},
						}},
						core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
							core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
								core.Input{Value: a.providerModelContext.Get, OnChange: a.providerModelContext.Set, Placeholder: "128000",
									Label: T("上下文"), TestID: "provider-model-context",
									Style: core.Style{Height: core.Pt(28), Padding: core.Symmetric(0, 8), CornerRadius: 6, FontSize: 11,
										FontFamily: ui.Mono, Color: colors.Text(), Background: colors.Field(),
										BorderWidth: 1, BorderColor: colors.FieldBorder()}},
							}},
							core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
								core.Input{Value: a.providerModelMax.Get, OnChange: a.providerModelMax.Set, Placeholder: "8192",
									Label: T("最大输出"), TestID: "provider-model-max",
									Style: core.Style{Height: core.Pt(28), Padding: core.Symmetric(0, 8), CornerRadius: 6, FontSize: 11,
										FontFamily: ui.Mono, Color: colors.Text(), Background: colors.Field(),
										BorderWidth: 1, BorderColor: colors.FieldBorder()}},
							}},
							ui.Switch{Checked: a.providerModelReasoning.Get, Label: T("推理"), TestID: "provider-model-reasoning",
								OnChange: a.providerModelReasoning.Set},
						}},
						core.View{Style: core.Style{Direction: core.Row, JustifyContent: core.JustifyEnd, Gap: 6}, Children: []core.Node{
							core.Show{When: func() bool { return a.providerModelEditing.Get() != "" }, Then: func(*core.Scope) core.Node {
								return ui.Button{Text: T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "provider-model-cancel",
									OnPress: a.resetModelForm}
							}},
							ui.Button{Text: T("保存模型"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "provider-model-save",
								OnPress: a.saveProviderModel},
						}},
					}},
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
					core.Show{When: func() bool { return a.providerBalance.Get() != "" }, Then: func(*core.Scope) core.Node {
						return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7}, Children: []core.Node{
							ui.Icon(lucide.Wallet, 12, func() core.Color { return balanceColor() }),
							core.Text{ContentFunc: func() string { return a.providerBalance.Get() }, MaxLines: 3,
								Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(balanceColor)},
						}}
					}},
					core.Text{Content: "只写回 api、baseUrl、apiKey 三个字段；models、compat 等保持原样。保存后重启 Agent 生效。",
						Style: core.Style{FontSize: 10.5, LineHeight: 16}, StyleFunc: ui.Colored(colors.Faint)},
				}},
			}}},
			Footer: []core.Node{
				ui.Button{Text: T("编辑原始 JSON"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
					a.openPiConfigFile("models.json")
				}},
				core.View{Style: core.Style{FlexGrow: 1}},
				ui.Button{Text: T("查询余额"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "provider-balance",
					OnPress: func() { a.queryProviderBalance() }},
				ui.Button{Text: T("测试连接"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "provider-test",
					OnPress: func() { a.testProvider() }},
				ui.Button{Text: T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.providerOpen.Set(false) }},
				ui.Button{Text: T("保存"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "provider-save",
					OnPress: func() { a.saveProvider() }},
			},
		}
	})
}
