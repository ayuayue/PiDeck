//go:build !js && !android && !ios

package workbench

// The settings window: a rail of sections beside the section's rows. Each
// row says what it is in a line and why in a quieter one, and the control
// sits at its end, so a section reads top to bottom.

import (
	"crypto/sha256"
	"fmt"
	"sort"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// settingsAddons lists the plugins, what each adds, and whether it runs.
func (a *app) settingsAddons() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		// Redrawn when any setting changes: their values live in the config.
		a.settingsTick()
		colors := ui.ColorsOf(cx)
		list := a.plugins.Get()
		pluginIDs := map[string]int{}
		for _, p := range list {
			pluginIDs[p.ID]++
		}
		var rows []core.Node
		if len(list) == 0 {
			rows = append(rows, setRow("还没有插件",
				"在数据目录的 plugins 里放一个 plugin.json，就能给命令面板加命令、给外观加主题。", nil))
		}
		for i, p := range list {
			plug := p
			desc := plug.Description
			if plug.Error != "" {
				desc = "读取失败：" + viewkit.FirstLine(plug.Error, 100)
			}
			title := plug.Name
			if plug.Version != "" {
				title += "  " + plug.Version
			}
			var control core.Node
			if plug.Error == "" {
				control = ui.Switch{
					Checked: func() bool { return !plug.Disabled },
					Label:   apptext.T("启用 ") + plug.Name,
					Size:    ui.SizeSmall,
					TestID:  "plugin-toggle-" + plug.ID,
					OnChange: func(on bool) {
						a.setPluginEnabled(plug.ID, on)

						a.bumpSettings()
					},
				}
			} else {
				control = ui.Text(apptext.T("无法读取"), 10.5, ui.Regular, colors.Danger)
			}
			if plug.Path != "" {
				dir, path := plug.Dir, plug.Path
				key := plug.ID
				if pluginIDs[plug.ID] > 1 {
					// Conflicting manifests share the domain ID. Use their paths
					// only to distinguish the repair controls, never plugin identity.
					sum := sha256.Sum256([]byte(path))
					key += fmt.Sprintf("-%x", sum[:8])
				}
				open := hintOf(func() string { return apptext.T("查看插件清单") }, ui.IconButton{Icon: lucide.FileText, Label: apptext.T("查看插件清单"), Size: 24, IconSize: 12,
					TestID: "plugin-open-" + key, OnPress: func() {
						a.settings.Set(false)
						a.openEditorFile(dir, path)
					}})
				controls := []core.Node{control, open}
				if canArchivePlugin(plug) {
					controls = append(controls, hintOf(func() string { return apptext.T("卸载插件") }, ui.IconButton{
						Icon: lucide.Trash, Label: apptext.T("卸载插件"), Size: 24, IconSize: 12,
						TestID: "plugin-uninstall-" + key, Disabled: a.pluginFileBusy.Get,
						OnPress: func() { a.uninstallPlugin(plug) },
					}))
				}
				control = core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4}, Children: controls}
			}
			rows = append(rows, setRow(title, desc, control))
			var lines []core.Node
			meta := pluginSummary(plug)
			if plug.Author != "" {
				meta += " · " + plug.Author
			}
			lines = append(lines, core.Text{Content: meta, Style: core.Style{FontSize: 10.5},
				StyleFunc: ui.Colored(colors.Faint)})
			for _, w := range plug.Warnings {
				lines = append(lines, core.Text{Content: apptext.T("注意：%s", w), Style: core.Style{FontSize: 10.5},
					StyleFunc: ui.Colored(colors.Warn)})
			}
			for _, c := range plug.Commands {
				label := "· " + c.Title
				if c.Group != "" {
					label += "  · " + c.Group
				}
				lines = append(lines, core.Text{Content: label, Style: core.Style{FontSize: 10.5},
					StyleFunc: ui.Colored(colors.Muted)})
			}
			for _, th := range plug.ThemeSpecs {
				lines = append(lines, core.Text{Content: apptext.T("· 主题 %s", th.Name), Style: core.Style{FontSize: 10.5},
					StyleFunc: ui.Colored(colors.Muted)})
			}
			for _, kb := range plug.Contributes.Keybindings {
				lines = append(lines, core.Text{Content: apptext.T("· 键位 %s → %s", kb.Key, kb.Command),
					Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)})
			}
			var hooks []string
			for name := range plug.Contributes.Hooks {
				hooks = append(hooks, name)
			}
			sort.Strings(hooks)
			for _, name := range hooks {
				lines = append(lines, core.Text{Content: apptext.T("· 事件 %s → %d 个动作", name, len(plug.Contributes.Hooks[name])),
					Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)})
			}
			for _, agent := range plug.Contributes.Agents {
				lines = append(lines, core.Text{Content: apptext.T("· 智能体 %s", agent.Name),
					Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Muted)})
			}
			if len(lines) > 0 {
				rows = append(rows, core.View{Style: core.Style{Padding: core.Edges{Left: 4, Bottom: 4}, Gap: 1}, Children: lines})
			}
			if plug.Error == "" && len(plug.Contributes.Settings) > 0 {
				var settingRows []core.Node
				for _, st := range plug.Contributes.Settings {
					setting := st
					settingRows = append(settingRows, setRow(setting.Label, setting.Description,
						a.pluginSettingControl(plug, setting)))
				}
				rows = append(rows, core.View{Style: core.Style{Padding: core.Edges{Left: 4, Bottom: 6}, Gap: 3}, Children: []core.Node{
					core.Text{Content: apptext.T("设置"), Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9, LetterSpacing: 0.5},
						StyleFunc: ui.Colored(colors.Faint)},
					core.View{StyleFunc: func() core.Style {
						return core.Style{Gap: 1, Padding: core.Symmetric(3, 8), CornerRadius: 7,
							Background: colors.Inset(), BorderWidth: 1, BorderColor: colors.Line()}
					}, Children: settingRows},
				}})
			}
			if i < len(list)-1 {
				rows = append(rows, setDivider())
			}
		}
		return a.scrollStashFor("settingsAddons:1").Bind(cx, core.Scroll{TestID: "settings-page", Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: scrollbarGutter}, Gap: 4}, Children: []core.Node{
				setGroup("插件", rows...),
				core.Text{Content: apptext.T("插件声明命令、设置、主题、键位、事件钩子和智能体；只执行宿主提供的动作，不运行插件代码。"),
					Style: core.Style{FontSize: 11, LineHeight: 17}, StyleFunc: ui.Colored(colors.Faint)},
				core.View{Style: core.Style{Direction: core.Row, Gap: 8, Margin: core.Edges{Top: 4}}, Children: []core.Node{
					ui.Button{Text: apptext.T("新建插件…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "plugin-new",
						OnPress: a.openPluginNew},
					ui.Button{Text: apptext.T("插件市场…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "plugin-market-open",
						OnPress: a.openPluginMarket},
					ui.Button{Text: apptext.T("打开插件目录"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() {
						a.openPluginsDir()
					}},
					ui.Button{Text: apptext.T("重新加载"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: a.reloadAddons},
				}},
				a.pluginArchiveSection(),
				pluginPreviewSection(),
			}},
		}})
	})
}

// pluginSettingControl is the control for one plugin setting: a switch,
// a row of choices, or a field that saves as it changes.
func (a *app) pluginSettingControl(p plugin, s pluginSetting) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		testID := "plugin-setting-" + p.ID + "-" + s.Key
		switch s.Type {
		case "bool":
			return ui.Switch{Checked: func() bool { return a.pluginSetting(p.ID, s.Key) == "true" },
				Label: s.Label, Size: ui.SizeSmall, TestID: testID,
				OnChange: func(on bool) {
					a.setPluginSetting(p.ID, s.Key, settingText(on))
					a.bumpSettings()
				}}
		case "select":
			var radios []core.Node
			for _, opt := range s.Options {
				value := opt
				radios = append(radios, ui.Radio{Text: opt, TestID: testID + "-" + value,
					Checked: func() bool { return a.pluginSetting(p.ID, s.Key) == value },
					OnChange: func(bool) {
						a.setPluginSetting(p.ID, s.Key, value)
						a.bumpSettings()
					}})
			}
			return ui.RadioGroup{Horizontal: true, Children: radios, Label: s.Label}
		case "number":
			// Keep incomplete input local until confirmation. A leading minus
			// or exponent is a useful editing state, never a persisted value.
			value := core.NewSignal(cx, a.pluginSetting(p.ID, s.Key))
			invalid := core.NewSignal(cx, false)
			commit := func() {
				v := value.GetUntracked()
				if v == a.pluginSetting(p.ID, s.Key) {
					invalid.Set(false)
					return
				}
				if !a.setPluginSetting(p.ID, s.Key, v) {
					invalid.Set(true)
					return
				}
				invalid.Set(false)
				a.bumpSettings()
			}
			return core.View{Style: core.Style{Gap: 3}, Children: []core.Node{
				core.Input{Value: value.Get, Label: s.Label, TestID: testID, Placeholder: settingText(s.Default),
					OnChange: func(v string) { value.Set(v); invalid.Set(false) },
					OnSubmit: func(string) { commit() }, OnBlur: commit,
					Style: core.Style{Height: core.Pt(26), Padding: core.Symmetric(0, 8), CornerRadius: 6, FontSize: 11,
						FontFamily: viewkit.MonoFont(), Color: colors.Text(), Background: colors.Field(),
						BorderWidth: 1, BorderColor: colors.FieldBorder(), MinWidth: core.Pt(150)}},
				core.Show{When: invalid.Get, Then: func(*core.Scope) core.Node {
					return core.Text{Content: apptext.T("请输入有效的有限数字。"), TestID: testID + "-error",
						Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Danger)}
				}},
			}}
		default:
			return core.Input{
				Value: func() string { return a.pluginSetting(p.ID, s.Key) }, Label: s.Label, TestID: testID,
				Placeholder: settingText(s.Default),
				OnChange: func(v string) {
					a.setPluginSetting(p.ID, s.Key, v)
					a.bumpSettings()
				},
				Style: core.Style{Height: core.Pt(26), Padding: core.Symmetric(0, 8), CornerRadius: 6, FontSize: 11,
					FontFamily: viewkit.MonoFont(), Color: colors.Text(), Background: colors.Field(),
					BorderWidth: 1, BorderColor: colors.FieldBorder(), MinWidth: core.Pt(150)},
			}
		}
	})
}
