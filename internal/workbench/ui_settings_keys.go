//go:build !js && !android && !ios

package workbench

// The settings window: a rail of sections beside the section's rows. Each
// row says what it is in a line and why in a quieter one, and the control
// sits at its end, so a section reads top to bottom.

import (
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// settingsKeys edits each command's shortcut. A field commits on Enter;
// an empty field unbinds, and "默认" puts the default back.
func (a *app) settingsKeys() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		// Redrawn when any setting changes: their values live in the config.
		a.settingsTick()
		colors := ui.ColorsOf(cx)
		var rows []core.Node
		cmds := a.keybindingCommands()
		for i, c := range cmds {
			cmd := c
			desc := apptext.T(cmd.Group)
			if src := a.bindingSource(cmd.ID); src != "" && src != "默认" {
				desc += " · " + src
			}
			field := core.Input{
				Value:       func() string { return a.effectiveKey(cmd.ID) },
				Placeholder: apptext.T("如 mod+shift+r"),
				Label:       cmd.Label + " 的键位",
				TestID:      "key-" + cmd.ID,
				OnSubmit: func(v string) {
					if !a.setKeybinding(cmd.ID, v) {
						return
					}
					if strings.TrimSpace(v) == "" {
						a.toast(ui.ToastInfo, "已取消绑定", cmd.Label)
					}
				},
				Style: core.Style{Width: core.Pt(150), Height: core.Pt(28), Padding: core.Symmetric(0, 8), FontSize: 11,
					FontFamily: viewkit.MonoFont(), Color: colors.Text(), Background: colors.Field(),
					BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 6},
			}
			reset := ui.Button{Text: apptext.T("默认"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				Disabled: func() bool {
					if a.cfg.Keybindings == nil {
						return true
					}
					_, set := a.cfg.Keybindings[cmd.ID]
					return !set
				},
				OnPress: func() { a.resetKeybinding(cmd.ID) }}
			control := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4},
				Children: []core.Node{field, reset}}
			rows = append(rows, setRow(cmd.Label, desc, control))
			if i < len(cmds)-1 {
				rows = append(rows, setDivider())
			}
		}
		var conflicts []core.Node
		for _, c := range a.keyConflicts {
			conflicts = append(conflicts, core.Text{Content: "· " + c, Style: core.Style{FontSize: 10.5, LineHeight: 16},
				StyleFunc: ui.Colored(colors.Warn)})
		}
		return core.Scroll{TestID: "settings-page", Ref: a.settingsScroll, OnScroll: a.settingsScrolled, Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: 2}, Gap: 6}, Children: []core.Node{
				setGroup("命令", rows...),
				core.Text{Content: apptext.T("写法：mod（Mac 的 Command / 其他平台的 Ctrl）、ctrl、alt、shift、meta 加键名，例如 mod+shift+g、ctrl+tab、f5。回车保存，留空取消绑定。"),
					Style: core.Style{FontSize: 11, LineHeight: 17}, StyleFunc: ui.Colored(colors.Faint)},
				core.Show{When: func() bool { return len(conflicts) > 0 }, Then: func(*core.Scope) core.Node {
					return setGroup("冲突", conflicts...)
				}},
				core.View{Style: core.Style{Direction: core.Row, Gap: 8, Margin: core.Edges{Top: 2}}, Children: []core.Node{
					ui.Button{Text: apptext.T("全部恢复默认"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: a.resetKeybindings},
				}},
			}},
		}}
	})
}
