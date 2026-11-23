//go:build !js && !android && !ios

package workbench

// The ACP preset manager: the presets on the left, the picked one on the
// right, split into what it launches and how it asks for permissions. A
// built-in stays read-only on disk until the user edits it; the edit is
// saved as its override in acp/presets.json and can be reverted.

import (
	"slices"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"example.com/pideck-v2/internal/viewkit/brands"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// openACPPresetManager shows the manager; the list picks a preset once it
// has been read, unless the user already picked one.
func (a *app) openACPPresetManager() {
	a.acpManageErr.Set("")
	a.acpPresetTab.Set("launch")
	a.acpPresetSel.Set("")
	a.acpManagePick = true
	a.acpManageOpen.Set(true)
	a.refreshACPManager()
}

// acpPresetManagerDialog is the split manager: list, editor, actions.
func (a *app) acpPresetManagerDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		selected := a.acpPresetSel.Get()
		row := func(preset acpPreset) core.Node {
			p := preset
			status := a.acpManager.Get().status[p.ID]
			ink := colors.Up
			if !status.ready {
				ink = colors.Warn
			}
			if !a.acpManager.Get().checked {
				status.label = apptext.T("检测中…")
				ink = colors.Faint
			}
			on := p.ID != "" && p.ID == selected
			lead := []core.Node{
				core.View{StyleFunc: func() core.Style {
					return core.Style{Width: core.Pt(6), Height: core.Pt(6), CornerRadius: 3, Background: ink()}
				}},
				// The agent's mark, so the list reads as brands and not as ids;
				// a preset the set does not know keeps the dot alone.
				brands.Mark(p.ID, 15, colors.Muted),
			}
			return core.View{
				OnPress: func(core.PressEvent) { a.editACPPreset(p) },
				Role:    core.RoleButton, Label: p.Name, TestID: "acp-preset-row-" + p.ID,
				StyleFunc: func() core.Style {
					st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, MinHeight: core.Pt(38),
						Padding: core.Symmetric(3, 7), CornerRadius: 7, Hover: &core.Style{Background: colors.Hover()}}
					if on {
						st.Background = colors.Pressed()
					}
					return st
				},
				Children: append(lead,
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
						core.Text{Content: p.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{FontSize: 12}, StyleFunc: ui.Colored(colors.Text)},
						core.Text{Content: status.label, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style: core.Style{FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
					}},
					core.Show{When: func() bool { return p.Builtin }, Then: func(*core.Scope) core.Node {
						label := apptext.T("内置")
						if p.Edited {
							label = apptext.T("已修改")
						}
						return core.View{Style: core.Style{Padding: core.Symmetric(1, 5), CornerRadius: 4, Background: colors.Inset()},
							Children: []core.Node{ui.Text(label, 9, ui.Medium, colors.Faint)}}
					}}),
			}
		}
		// The list lives in its own Dynamic so its rows arriving does not
		// renumber the editor beside it: a field that changes identity
		// mid-typing loses keystrokes.
		rows := core.Dynamic(func(*core.Scope) core.Node {
			var list []core.Node
			for _, p := range a.acpManager.Get().presets {
				list = append(list, row(p))
			}
			if len(list) == 0 {
				list = append(list, core.Text{Content: apptext.T("正在读取预设…"), Style: core.Style{FontSize: 11, Padding: core.Symmetric(6, 4)},
					StyleFunc: ui.Colored(colors.Faint)})
			}
			return core.Scroll{TestID: "acp-preset-list", Style: core.Style{FlexGrow: 1, MinHeight: core.Pt(0), MaxHeight: core.Pt(430)},
				Children: []core.Node{core.View{Style: core.Style{Gap: 1}, Children: list}}}
		})
		list := core.View{Style: core.Style{Width: core.Pt(236), Gap: 4, FlexShrink: 0}, Children: []core.Node{
			ui.Button{Text: apptext.T("新增预设"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "acp-preset-new",
				OnPress: a.newACPPreset},
			rows,
		}}
		return ui.Dialog{
			Open:         a.acpManageOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.acpManageOpen.Set(open) },
			Title:        apptext.T("管理 ACP 预设"),
			TestID:       "acp-preset-manager",
			Style:        core.Style{Width: a.dialogWidth(), MaxHeight: core.Pt(700)},
			Children: []core.Node{core.View{Style: core.Style{Direction: core.Row, Gap: 12, Height: core.Pt(470)},
				Children: []core.Node{list, a.acpPresetEditor(cx)}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("检测"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
					TestID: "acp-preset-check", OnPress: a.refreshACPManager},
				ui.Button{Text: apptext.T("打开预设目录"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.openACPDir() }},
				core.View{Style: core.Style{FlexGrow: 1}},
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "acp-preset-close",
					OnPress: func() { a.acpManageOpen.Set(false) }},
			},
		}
	})
}

// acpPresetEditor is the right pane: the picked preset, its launch fields
// and its permission defaults in two tabs.
func (a *app) acpPresetEditor(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	snapshot := a.acpManager.Get()
	sel := a.acpPresetSel.Get()
	var preset *acpPreset
	for i := range snapshot.presets {
		if snapshot.presets[i].ID == sel && sel != "" {
			preset = &snapshot.presets[i]
			break
		}
	}
	title := apptext.T("新增预设")
	status := acpPresetStatus{label: apptext.T("尚未保存")}
	if preset != nil {
		title = preset.Name
		status = snapshot.status[preset.ID]
		if !snapshot.checked {
			status.label = apptext.T("检测中…")
		}
	}
	fieldStyle := core.Style{Height: core.Pt(30), Padding: core.Symmetric(0, 8), CornerRadius: 6, FontSize: 11,
		FontFamily: viewkit.MonoFont(), Color: colors.Text(), Background: colors.Field(),
		BorderWidth: 1, BorderColor: colors.FieldBorder()}
	field := func(value func() string, set func(string), placeholder, label, testID string) core.Node {
		return core.View{Style: core.Style{Gap: 3}, Children: []core.Node{
			ui.Text(apptext.T(label), 10, ui.Medium, colors.Muted),
			core.Input{Value: value, OnChange: set, Placeholder: apptext.T(placeholder), Label: apptext.T(label),
				TestID: testID, Style: fieldStyle},
		}}
	}
	// Typing into a field cancels the pending first pick, so a snapshot that
	// arrives late never replaces what the user already wrote.
	editable := func(sig *core.Signal[string]) func(string) {
		return func(v string) {
			a.acpManagePick = false
			sig.Set(v)
		}
	}
	var actions []core.Node
	if preset != nil {
		switch {
		case !status.ready && snapshot.npm:
			if _, ok := acpPresetInstallArgs(preset.ID); ok {
				label := apptext.T("安装")
				if a.acpInstalling.Get() == preset.ID {
					label = apptext.T("正在安装…")
				}
				actions = append(actions, ui.Button{Text: label, Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
					TestID: "acp-preset-install-run-" + preset.ID, Disabled: func() bool { return a.acpInstalling.Get() != "" },
					OnPress: func() { a.installACPPreset(preset.ID, preset.Name) }})
			}
		case acpPresetInstall(*preset) != "":
			cmd := acpPresetInstall(*preset)
			actions = append(actions, ui.Button{Text: apptext.T("复制安装命令"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				TestID: "acp-preset-install-" + preset.ID, OnPress: func() { a.copyText(cmd, apptext.T("安装命令")) }})
		}
		if preset.Homepage != "" {
			url := preset.Homepage
			actions = append(actions, ui.Button{Text: apptext.T("文档"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				TestID: "acp-preset-docs-" + preset.ID, OnPress: func() { a.cx.OpenURL(url, nil) }})
		}
		label := apptext.T("删除")
		if preset.Builtin {
			label = apptext.T("恢复默认")
		}
		// A built-in nobody changed has nothing to revert to.
		if preset.Builtin && !preset.Edited {
			label = ""
		}
		if label != "" {
			actions = append(actions, ui.Button{Text: label, Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				TestID: "acp-preset-remove-" + preset.ID, Disabled: a.acpManageBusy.Get,
				OnPress: func() { a.removeACPPreset(preset.ID) }})
		}
	}
	launch := core.View{Style: core.Style{Gap: 9}, Children: []core.Node{
		core.View{Style: core.Style{Gap: 9, FlexShrink: 1, MinHeight: core.Pt(0)}, Children: []core.Node{
			core.Show{When: func() bool { return a.acpPresetSel.Get() == "" }, Then: func(*core.Scope) core.Node {
				return field(a.acpEditID.Get, editable(a.acpEditID), "my-agent", "预设 id", "acp-preset-id")
			}},
			field(a.acpEditName.Get, editable(a.acpEditName), "我的 Agent", "预设名称", "acp-preset-name"),
			field(a.acpEditCommand.Get, editable(a.acpEditCommand), "npx / my-agent", "命令", "acp-preset-command"),
			field(a.acpEditArgs.Get, editable(a.acpEditArgs), "-y @scope/agent-acp --acp（空格分隔）", "参数", "acp-preset-args"),
			field(a.acpEditEnv.Get, editable(a.acpEditEnv), "KEY=VALUE；多个用 ; 分隔", "环境变量", "acp-preset-env"),
			core.Text{Content: apptext.T("环境变量只交给这个 CLI 的进程，用来放它要的密钥；它不会出现在日志里。"),
				MaxLines: 2, Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Faint)},
			core.Show{When: func() bool { return a.acpManageErr.Get() != "" }, Then: func(*core.Scope) core.Node {
				return core.Text{Content: a.acpManageErr.Get(), MaxLines: 3, Style: core.Style{FontSize: 11, LineHeight: 16},
					StyleFunc: ui.Colored(colors.Danger)}
			}},
		}},
		core.View{Style: core.Style{FlexGrow: 1}},
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Wrap: core.Wrap}, Children: append([]core.Node{
			ui.Button{Text: apptext.T("保存"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "acp-preset-save",
				Disabled: a.acpManageBusy.Get, OnPress: a.saveACPPresetEdit},
		}, actions...)},
	}}
	access := a.acpPresetAccessPane(cx, preset)
	var pane core.Node
	if a.acpPresetTab.Get() == "access" {
		pane = access
	} else {
		pane = launch
	}
	return core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 8}, Children: []core.Node{
		core.View{Style: core.Style{Gap: 1}, Children: []core.Node{
			core.Text{Content: title, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FontSize: 13}, StyleFunc: ui.Colored(colors.Text)},
			core.Text{Content: status.label, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style: core.Style{FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
		}},
		a.acpPresetTabs(cx),
		pane,
	}}
}

// acpPresetTabs is the editor's tab strip: what the preset launches, and
// how it asks for permissions. Chips rather than ui.Tabs, so the fields
// beside them keep their focus and identity while the user types.
func (a *app) acpPresetTabs(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	tab := func(value, label, testID string) core.Node {
		on := func() bool { return a.acpPresetTab.Get() == value }
		return core.View{
			OnPress: func(core.PressEvent) { a.acpPresetTab.Set(value) },
			Role:    core.RoleTab,
			Label:   apptext.T(label),
			TestID:  testID,
			StyleFunc: func() core.Style {
				st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Height: core.Pt(26),
					Padding: core.Symmetric(0, 9), CornerRadius: 6, Hover: &core.Style{Background: colors.Hover()}}
				if on() {
					st.Background = colors.Pressed()
				}
				return st
			},
			Children: []core.Node{core.Text{Content: apptext.T(label), MaxLines: 1,
				Style: core.Style{FontSize: 11.5},
				StyleFunc: ui.Colored(func() core.Color {
					if on() {
						return colors.Text()
					}
					return colors.Muted()
				})}},
		}
	}
	return core.View{TestID: "acp-preset-tabs",
		Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 2}, Children: []core.Node{
			tab("launch", "启动参数", "acp-preset-tab-launch"),
			tab("access", "权限与选项", "acp-preset-tab-access"),
		}}
}

// acpPresetAccessPane is the permissions tab: the preset's bypass default
// and the choices the user made in earlier sessions of this preset.
func (a *app) acpPresetAccessPane(cx *core.Scope, preset *acpPreset) core.Node {
	colors := ui.ColorsOf(cx)
	rows := []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 12, MinHeight: core.Pt(38)},
			Children: []core.Node{
				core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
					ui.Text(apptext.T("旁路权限"), 12.5, ui.Regular, colors.Text),
					core.Text{Content: apptext.T("开会话时自动切到这个 CLI 的「不再询问」档；CLI 没有该档时保持它自己的默认。"),
						MaxLines: 2, Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Muted)},
				}},
				ui.Switch{Checked: a.acpEditBypass.Get, OnChange: a.acpEditBypass.Set, Label: apptext.T("旁路权限"),
					Size: ui.SizeSmall, TestID: "acp-preset-bypass"},
			}},
	}
	if preset != nil && a.st != nil {
		pref := a.st.config().ACPChoices[preset.ID]
		var remembered []core.Node
		if pref.Mode != "" {
			remembered = append(remembered, a.rememberedRow(cx, apptext.T("模式"), pref.Mode))
		}
		for _, key := range sortedPreferenceKeys(pref.Values) {
			remembered = append(remembered, a.rememberedRow(cx, key, pref.Values[key]))
		}
		if len(remembered) == 0 {
			remembered = append(remembered, core.Text{Content: apptext.T("还没有记住的选项。在会话的 ACP 面板里选过的模式、思考档与权限会记在这里。"),
				MaxLines: 3, Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Faint)})
		} else {
			remembered = append(remembered, core.View{Style: core.Style{Direction: core.Row, Margin: core.Edges{Top: 4}},
				Children: []core.Node{ui.Button{Text: apptext.T("清除记忆"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					TestID: "acp-preset-forget", OnPress: func() {
						a.clearACPPreference(preset.ID)
						a.refreshACPManager()
					}}}})
		}
		rows = append(rows, core.View{Style: core.Style{Height: core.Pt(1), Margin: core.Symmetric(8, 0)}, StyleFunc: ui.Filled(colors.Line)},
			ui.Text(apptext.T("已记住的选项"), 10.5, ui.Medium, colors.Muted),
			core.Scroll{Style: core.Style{MaxHeight: core.Pt(220)}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 2}, Children: remembered}}})
	}
	rows = append(rows, core.Text{Content: apptext.T("预设改动写在 acp/presets.json；内置预设被改过后显示为「已修改」，随时可以恢复默认。"),
		MaxLines: 3, Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Faint)})
	return core.View{Style: core.Style{Gap: 8}, Children: rows}
}

// rememberedRow is one stored choice: the option id and its value.
func (a *app) rememberedRow(cx *core.Scope, id, value string) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{TestID: "acp-preset-remembered-" + id,
		Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(24)},
		Children: []core.Node{
			core.Text{Content: id, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style:     core.Style{FlexGrow: 1, MinWidth: core.Pt(0), FontSize: 10.5, FontFamily: viewkit.MonoFont()},
				StyleFunc: ui.Colored(colors.Muted)},
			core.Text{Content: value, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle, Selectable: core.SelectableOn,
				Style: core.Style{FontSize: 10.5, FontFamily: viewkit.MonoFont()}, StyleFunc: ui.Colored(colors.Text)},
		}}
}

// sortedPreferenceKeys keeps the remembered list in a stable order.
func sortedPreferenceKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}
