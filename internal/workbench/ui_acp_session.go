//go:build !js && !android && !ios

package workbench

import (
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// acpBadge names the ACP preset, its state and its mode, and opens the
// agent's own panel: the mode list, what it was started with, its commands
// and the way to reconnect.
func (a *app) acpBadge(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		preset := a.acpPresetByID(s.acpPreset)
		name := "ACP"
		if preset != nil {
			name = preset.Name
		}
		modes := s.acpModes.Get()
		label := name
		if mode := s.acpMode.Get(); mode != "" {
			label += " · " + acpModeLabel(modes, mode)
		}
		dot := colors.Faint
		switch {
		case s.status.Get() == statusFailed:
			dot = colors.Danger
		case s.starting && !s.readySig.Get():
			dot = colors.Warn
		case s.readySig.Get():
			dot = colors.Up
		}
		chip := core.View{OnPress: func(core.PressEvent) { s.acpModeOpen.Update(func(v bool) bool { return !v }) },
			Role: core.RoleButton, Label: apptext.T("ACP · %s", label), TestID: "acp-mode-badge",
			Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Height: core.Pt(26), FlexShrink: 0,
				Padding: core.Symmetric(0, 8), CornerRadius: 7, Background: colors.Inset(),
				Hover: &core.Style{Background: colors.Hover()}},
			Children: []core.Node{
				core.View{StyleFunc: func() core.Style {
					return core.Style{Width: core.Pt(6), Height: core.Pt(6), CornerRadius: 3, Background: dot()}
				}},
				core.Text{Content: label, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 11.5, MinWidth: core.Pt(0), FlexShrink: 1}, StyleFunc: ui.Colored(colors.Text)},
				ui.Icon(lucide.ChevronDown, 9.5, colors.Faint),
			}}
		trigger := hintOf(func() string {
			if s.readySig.Get() {
				return apptext.T("ACP · %s（点一下看模式与启动参数）", name)
			}
			return apptext.T("ACP · %s（启动中）", name)
		}, chip)
		return a.popoverCard(s.acpModeOpen, core.PlaceTop, core.AlignStart, 300, trigger, func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			var rows []core.Node
			changing := s.acpOptionBusy.Get() || s.runningSig.Get() || !s.readySig.Get()
			if len(modes) > 0 {
				current := s.acpMode.Get()
				rows = append(rows, composerPanelTitle(cx, apptext.T("模式")))
				for _, m := range modes {
					mode := m
					title := mode.Name
					if title == "" {
						title = mode.ID
					}
					row := composerRow(cx, nil, title, mode.Description, mode.ID == current, changing, func() {
						a.setACPMode(s, mode.ID)
					})
					row.TestID = "acp-mode-" + mode.ID
					rows = append(rows, row)
				}
				rows = append(rows, composerDivider(cx))
			}
			for _, opt := range s.acpOptions.Get() {
				option := opt
				if option.ID == "" {
					continue
				}
				if option.isBool() {
					rows = append(rows, composerPanelTitle(cx, firstNonEmpty(option.Name, option.ID)),
						a.acpSwitchRow(cx, s, option, changing), composerDivider(cx))
					continue
				}
				values := option.Choices()
				if len(values) == 0 {
					continue
				}
				rows = append(rows, composerPanelTitle(cx, firstNonEmpty(option.Name, option.ID)))
				choices := make([]core.Node, 0, len(values))
				for _, choice := range values {
					value := choice.Value
					row := composerRow(cx, nil, firstNonEmpty(choice.Name, value), choice.Description,
						value == option.CurrentValue.text(), changing, func() { a.chooseACPOption(s, option.ID, acpTextValue(value)) })
					row.TestID = "acp-option-" + option.ID + "-" + value
					choices = append(choices, row)
				}
				rows = append(rows, core.Scroll{Style: core.Style{MaxHeight: core.Pt(130)}, Children: choices}, composerDivider(cx))
			}
			if s.starting && !s.readySig.Get() {
				rows = append(rows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6,
					Padding: core.Symmetric(4, 8)}, Children: []core.Node{
					ui.Spinner{Size: 11},
					ui.Text(apptext.T("正在启动 agent…"), 11, ui.Regular, colors.Muted),
				}})
			}
			rows = append(rows, composerPanelTitle(cx, apptext.T("启动参数")))
			param := func(label, value string) core.Node {
				return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignStart, Gap: 8, Padding: core.Symmetric(2, 8)},
					Children: []core.Node{
						core.Text{Content: label, Style: core.Style{FontSize: 10.5, Width: core.Pt(64), FlexShrink: 0},
							StyleFunc: ui.Colored(colors.Faint)},
						core.Text{Content: value, MaxLines: 2, EllipsizeMode: core.EllipsizeMiddle, Selectable: core.SelectableOn,
							Style:     core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10.5, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)},
							StyleFunc: ui.Colored(colors.Muted)},
					}}
			}
			cmd, args := "", ""
			if preset != nil {
				cmd, args = preset.Command, strings.Join(preset.Args, " ")
			}
			sessionID := s.acpSID
			if sessionID == "" {
				sessionID = apptext.T("（还没有建立）")
			}
			rows = append(rows,
				param(apptext.T("命令"), firstNonEmpty(cmd, "—")),
				param(apptext.T("参数"), firstNonEmpty(args, "—")),
				param(apptext.T("工作目录"), s.WS),
				param(apptext.T("会话"), sessionID),
			)
			if cmds := s.acpCommands.Get(); len(cmds) > 0 {
				rows = append(rows, composerDivider(cx), composerPanelTitle(cx, apptext.T("命令（插入输入框）")))
				for _, c := range cmds {
					cmd := c
					rows = append(rows, composerRow(cx, lucide.Command, "/"+cmd.Name, cmd.Description, false, false, func() {
						draft := s.draft.GetUntracked()
						if draft != "" && !strings.HasSuffix(draft, " ") && !strings.HasSuffix(draft, "\n") {
							draft += " "
						}
						s.draft.Set(draft + "/" + cmd.Name + " ")
						s.acpModeOpen.Set(false)
					}))
				}
			}
			rows = append(rows, composerDivider(cx), core.View{Style: core.Style{Direction: core.Row, Gap: 6, Padding: core.Symmetric(2, 0)},
				Children: []core.Node{
					ui.Button{Text: apptext.T("重连"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "acp-reconnect",
						OnPress: func() { s.acpModeOpen.Set(false); a.reconnectACP(s) }},
					ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
						OnPress: func() { s.acpModeOpen.Set(false) }},
				}})
			return core.View{Style: core.Style{Gap: 1}, Children: rows}
		}, "acp-info-menu")
	})
}

// acpSwitchRow is an on/off option in the ACP panel: some agents keep the
// approvals toggle there instead of in the mode list.
func (a *app) acpSwitchRow(cx *core.Scope, s *session, option acpConfigOption, disabled bool) core.Node {
	colors := ui.ColorsOf(cx)
	label := firstNonEmpty(option.Name, option.ID)
	title := []core.Node{core.Text{Content: label, MaxLines: 1, Style: core.Style{FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)}}
	if option.Description != "" {
		title = append(title, core.Text{Content: option.Description, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
			Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)})
	}
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(30),
		Padding: core.Symmetric(2, 8)}, Children: []core.Node{
		core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: title},
		ui.Switch{Checked: func() bool { return option.CurrentValue.truthy() },
			OnChange: func(on bool) { a.chooseACPOption(s, option.ID, acpBoolValue(on)) },
			Label:    label, Size: ui.SizeSmall, Disabled: func() bool { return disabled },
			TestID: "acp-option-" + option.ID},
	}}
}

// acpModeLabel maps a mode id to the name the agent gave it.
func acpModeLabel(modes []acpMode, id string) string {
	for _, m := range modes {
		if m.ID == id && m.Name != "" {
			return m.Name
		}
	}
	return id
}

// acpOpenDialog shows the preset picker.
func (a *app) acpOpenDialog() {
	a.acpOpen.Set(true)
}

// acpDialog lists the presets.
func (a *app) acpDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		def := ""
		if ws := a.activeWorkspace(); ws != nil {
			def = ws.ACPPreset
		}
		var rows []core.Node
		for _, p := range a.acpPresetList() {
			preset := p
			rows = append(rows, core.View{
				OnPress: func(core.PressEvent) {
					a.acpOpen.Set(false)
					if ws := a.activeWorkspace(); ws != nil {
						a.newACPSession(ws, preset)
					}
				},
				Role: core.RoleButton, Label: preset.Name, TestID: "acp-preset-" + preset.ID,
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, MinHeight: core.Pt(40),
						Padding: core.Symmetric(4, 8), CornerRadius: 7, Hover: &core.Style{Background: colors.Hover()}}
				},
				Children: []core.Node{
					ui.Icon(lucide.Bot, 14, colors.Muted),
					core.View{Style: core.Style{FlexGrow: 1, Gap: 1}, Children: []core.Node{
						core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5}, Children: []core.Node{
							core.Text{Content: preset.Name, Style: core.Style{FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
							core.Show{When: func() bool { return preset.ID == def }, Then: func(*core.Scope) core.Node {
								return ui.Icon(lucide.Star, 10, colors.Accent)
							}},
						}},
						core.Text{Content: preset.Command + " " + strings.Join(preset.Args, " "), MaxLines: 1,
							EllipsizeMode: core.EllipsizeMiddle, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5},
							StyleFunc: ui.Colored(colors.Faint)},
					}},
				},
			})
		}
		return ui.Dialog{
			Open:         a.acpOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.acpOpen.Set(open) },
			Title:        apptext.T("新建 ACP 会话"),
			TestID:       "acp-dialog",
			Style:        core.Style{Width: a.dialogWidth()},
			Children:     []core.Node{core.View{Style: core.Style{Gap: 4}, Children: rows}},
			Footer: []core.Node{
				core.Show{When: func() bool { return def != "" }, Then: func(*core.Scope) core.Node {
					return ui.Button{Text: apptext.T("清除默认"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
						OnPress: func() { a.clearACPPreset(a.activeWorkspace()) }}
				}},
				ui.Button{Text: apptext.T("打开预设目录"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: a.openACPDir},
				ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.acpOpen.Set(false) }},
			},
		}
	})
}
