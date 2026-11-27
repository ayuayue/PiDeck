//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// settingsKeys keeps its search controls mounted while the grouped list
// changes. Draft keys apply on Enter or blur, through the existing router.
func (a *app) settingsKeys() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		query := core.NewSignal(cx, "")
		modified := core.NewSignal(cx, false)
		searchRef := new(core.Ref)
		colors := ui.ColorsOf(cx)
		clear := func() { query.Set(""); modified.Set(false); searchRef.Focus() }
		return core.View{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Gap: 8, Padding: core.Edges{Top: 6, Bottom: 12, Right: viewkit.PanelInset}}, Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, AlignItems: core.AlignCenter, Gap: 12}, Children: []core.Node{
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, FlexGrow: 1, FlexShrink: 1, FlexBasis: core.Pt(260), MinWidth: core.Pt(0),
						Height: core.Pt(viewkit.PanelControlSize), Padding: core.Symmetric(0, 8), CornerRadius: 6},
						StyleFunc: func() core.Style {
							return core.Style{Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder()}
						},
						Children: []core.Node{
							ui.Icon(lucide.Search, 13, colors.Muted),
							core.Input{Ref: searchRef, Value: query.Get, OnChange: query.Set, Role: core.RoleSearchField,
								Placeholder: apptext.T("搜索命令或快捷键"), Label: apptext.T("搜索命令或快捷键"), TestID: "keys-search",
								Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Height: core.Pt(viewkit.PanelLineHeight), FontSize: viewkit.PanelTextSize},
								StyleFunc: func() core.Style {
									return core.Style{Color: colors.Text(), PlaceholderColor: colors.Muted(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection, FocusVisible: ui.FocusRing(cx, 2)}
								}},
							core.Show{When: func() bool { return query.Get() != "" }, Then: func(*core.Scope) core.Node {
								return ui.IconButton{Icon: lucide.X, Label: apptext.T("清空搜索"), TestID: "keys-clear-search", Size: 18, IconSize: 12,
									OnPress: func() { query.Set(""); searchRef.Focus() }}
							}},
						}},
					ui.Checkbox{Text: apptext.T("仅显示已修改"), Checked: modified.Get, OnChange: modified.Set, TestID: "keys-modified-only"},
					ui.Button{Text: apptext.T("全部恢复默认"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "keys-reset-all",
						Disabled: func() bool { a.settingsTick(); return len(a.cfg.Keybindings) == 0 },
						OnPress: func() {
							a.askConfirmPrimary(apptext.T("恢复所有默认快捷键？"), apptext.T("这会清除所有自定义键位和取消绑定的设置，包括当前筛选之外的命令。"), apptext.T("全部恢复默认"), a.resetKeybindings)
						}},
				}},
				core.Text{Content: apptext.T("mod 在 macOS 上是 Command，在其他平台上是 Ctrl。示例：mod+shift+g、ctrl+tab、f5。"),
					Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: 18}, StyleFunc: ui.Colored(colors.Muted)},
			}},
			core.Dynamic(func(cx *core.Scope) core.Node {
				a.settingsTick()
				commands := a.settingsKeyCommands(query.Get(), modified.Get())
				var titles []string
				groups := map[string][]core.Node{}
				for _, command := range commands {
					title := firstNonEmpty(command.Group, "命令")
					if _, exists := groups[title]; !exists {
						titles = append(titles, title)
					} else {
						groups[title] = append(groups[title], setDivider())
					}
					groups[title] = append(groups[title], a.settingsKeyRow(command))
				}
				content := []core.Node{
					core.Text{Content: fmt.Sprintf(apptext.T("%d 条快捷键"), len(commands)), TestID: "keys-result-count",
						Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: 18, Margin: core.Edges{Bottom: 8}}, StyleFunc: ui.Colored(colors.Muted)},
				}
				if len(a.keyConflicts) > 0 {
					var warnings []core.Node
					for _, conflict := range a.keyConflicts {
						warnings = append(warnings, core.Text{Content: conflict, Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: 18}, StyleFunc: ui.Colored(colors.Danger)})
					}
					content = append(content, setGroup("冲突", warnings...))
				}
				for _, title := range titles {
					content = append(content, setGroup(title, groups[title]...))
				}
				if len(commands) == 0 {
					content = append(content, core.View{TestID: "keys-empty", Style: core.Style{Gap: 8, AlignItems: core.AlignStart, Padding: core.Symmetric(20, 0)}, Children: []core.Node{
						ui.Text(apptext.T("没有匹配的快捷键"), viewkit.PanelTextSize, ui.Medium, colors.Text),
						core.Text{Content: apptext.T("试试其他命令名称或键位，或清除筛选。"), Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: 18}, StyleFunc: ui.Colored(colors.Muted)},
						ui.Button{Text: apptext.T("清除筛选"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "keys-clear-filters", OnPress: clear},
					}})
				}
				return a.scrollStashFor("settingsKeys:1").Bind(cx, core.Scroll{TestID: "settings-page", Style: ui.FillRest, Children: []core.Node{
					core.View{Style: core.Style{Padding: core.Edges{Bottom: 20, Right: viewkit.PanelInset}}, Children: content},
				}})
			}),
		}}
	})
}

// settingsKeyCommands searches translated labels, IDs, groups and current
// keys. Modified means a saved user override, including an explicit unbind.
func (a *app) settingsKeyCommands(query string, modifiedOnly bool) []appCommand {
	query = strings.ToLower(strings.TrimSpace(query))
	compact := strings.ReplaceAll(query, " ", "")
	var result []appCommand
	for _, command := range a.keybindingCommands() {
		if _, changed := a.cfg.Keybindings[command.ID]; modifiedOnly && !changed {
			continue
		}
		text := strings.ToLower(strings.Join([]string{command.ID, command.Label, apptext.T(command.Label), command.Group, apptext.T(command.Group), a.effectiveKey(command.ID)}, " "))
		if query != "" && !strings.Contains(text, query) && !strings.Contains(a.effectiveKey(command.ID), compact) {
			continue
		}
		result = append(result, command)
	}
	return result
}

func (a *app) settingsKeyRow(command appCommand) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		key := a.effectiveKey(command.ID)
		draft, failure := core.NewSignal(cx, key), core.NewSignal(cx, "")
		_, changed := a.cfg.Keybindings[command.ID]
		description := ""
		if changed {
			description = apptext.T("已修改")
			if key == "" {
				description = apptext.T("未绑定")
			}
			if command.Shortcut != "" {
				description = fmt.Sprintf(apptext.T("%s · 默认：%s"), description, command.Shortcut)
			}
		} else if source := a.bindingSource(command.ID); source != "" && source != "默认" {
			description = fmt.Sprintf(apptext.T("来自插件：%s"), source)
		}
		commit := func() {
			value := strings.TrimSpace(draft.GetUntracked())
			if normalizeKey(value) == a.effectiveKey(command.ID) {
				draft.Set(a.effectiveKey(command.ID))
				failure.Set("")
				return
			}
			if other := a.keymap[normalizeKey(value)]; value != "" && other != "" && other != command.ID {
				label := other
				for _, candidate := range a.commandList() {
					if candidate.ID == other {
						label = apptext.T(candidate.Label)
						break
					}
				}
				failure.Set(fmt.Sprintf(apptext.T("%s 已用于“%s”，请改用其他组合键。"), value, label))
				return
			}
			if a.setKeybinding(command.ID, value) {
				draft.Set(a.effectiveKey(command.ID))
				failure.Set("")
			}
		}
		field := core.Input{Value: draft.Get, OnChange: func(value string) { draft.Set(value); failure.Set("") }, OnSubmit: func(string) { commit() }, OnBlur: commit,
			Placeholder: apptext.T("未绑定"), Label: fmt.Sprintf(apptext.T("%s 的快捷键"), apptext.T(command.Label)), TestID: "key-" + command.ID,
			Style: settingsSelectStyle().Merge(core.Style{Width: core.Pct(100), FontFamily: viewkit.MonoFont(), Padding: core.Symmetric(0, 8), CornerRadius: 6, BorderWidth: 1}),
			StyleFunc: func() core.Style {
				border := colors.FieldBorder()
				if failure.Get() != "" {
					border = colors.Danger()
				}
				return core.Style{Color: colors.Text(), Background: colors.Field(), BorderColor: border, PlaceholderColor: colors.Muted(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection, FocusVisible: ui.FocusRing(cx, 2)}
			}}
		control := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignStart, Gap: 8, Width: core.Pt(312), MaxWidth: core.Pct(100), FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 4}, Children: []core.Node{
				field,
				core.Show{When: func() bool { return failure.Get() != "" }, Then: func(*core.Scope) core.Node {
					return core.Text{ContentFunc: failure.Get, TestID: "key-error-" + command.ID,
						Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: 18}, StyleFunc: ui.Colored(colors.Danger)}
				}},
			}},
			ui.Button{Text: apptext.T("恢复默认"), Label: fmt.Sprintf(apptext.T("%s：恢复默认快捷键"), apptext.T(command.Label)), TestID: "key-reset-" + command.ID,
				Variant: ui.ButtonGhost, Size: ui.SizeSmall, Disabled: func() bool { return !changed }, OnPress: func() { a.resetKeybinding(command.ID) }},
		}}
		return setRow(command.Label, description, control)
	})
}
