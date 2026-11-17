//go:build !js && !android && !ios

package main

// The keyboard cheat sheet: every command with a key, grouped, searchable,
// and a way into the key editor.

import (
	"strings"

	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// shortcutsDialog lists the commands that have keys.
func (a *app) shortcutsDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return ui.Dialog{
			Open:         a.shortcutsOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.shortcutsOpen.Set(open) },
			Title:        T("键盘快捷键"),
			TestID:       "shortcuts",
			Style:        core.Style{Width: core.Pt(560), Height: core.Pt(600)},
			Children: []core.Node{core.View{Style: core.Style{FlexGrow: 1, MinHeight: core.Pt(0), Gap: 8}, Children: []core.Node{
				core.Input{Value: a.shortcutsQuery.Get, OnChange: a.shortcutsQuery.Set, Placeholder: T("搜索命令或键位…"),
					Label: T("搜索快捷键"), TestID: "shortcuts-search", AutoFocus: true,
					Style: core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 9), CornerRadius: 7,
						Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(),
						Color: colors.Text(), FontSize: 12}},
				// Only the list follows the query: rebuilding the field
				// would take the text the user is typing with it.
				core.Dynamic(func(cx *core.Scope) core.Node {
					colors := ui.ColorsOf(cx)
					query := strings.ToLower(strings.TrimSpace(a.shortcutsQuery.Get()))
					var order []string
					grouped := map[string][]appCommand{}
					for _, c := range a.keybindingCommands() {
						key := a.effectiveKey(c.ID)
						if query != "" {
							hay := strings.ToLower(c.Label + " " + c.Group + " " + key)
							if !strings.Contains(hay, query) {
								continue
							}
						}
						if _, ok := grouped[c.Group]; !ok {
							order = append(order, c.Group)
						}
						grouped[c.Group] = append(grouped[c.Group], c)
					}
					var groups []core.Node
					for _, g := range order {
						list := grouped[g]
						var rows []core.Node
						for i, c := range list {
							cmd := c
							key := a.effectiveKey(cmd.ID)
							chip := core.View{StyleFunc: func() core.Style {
								if key == "" {
									return core.Style{Padding: core.Symmetric(1, 7), CornerRadius: 5}
								}
								return core.Style{Padding: core.Symmetric(1, 7), CornerRadius: 5, Background: colors.Inset(),
									BorderWidth: 1, BorderColor: colors.Line()}
							}, Children: []core.Node{core.Text{Content: keyLabel(key), Style: core.Style{FontFamily: ui.Mono, FontSize: 10},
								StyleFunc: ui.Colored(func() core.Color {
									if key == "" {
										return colors.Faint()
									}
									return colors.Muted()
								})}}}
							rows = append(rows, setRow(cmd.Label, "", chip))
							if i < len(list)-1 {
								rows = append(rows, setDivider())
							}
						}
						groups = append(groups, setGroup(g, rows...))
					}
					if len(groups) == 0 {
						groups = append(groups, core.View{Style: core.Style{Padding: core.Symmetric(20, 8), AlignItems: core.AlignCenter},
							Children: []core.Node{ui.Text("没有匹配的快捷键", 12, ui.Regular, colors.Faint)}})
					}
					return core.Scroll{Style: ui.FillRest, Children: []core.Node{
						core.View{Style: core.Style{Gap: 2, Padding: core.Edges{Right: 4}}, Children: groups},
					}}
				}),
			}}},
			Footer: []core.Node{
				ui.Button{Text: T("打开键位设置"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "shortcuts-settings",
					OnPress: func() {
						a.shortcutsOpen.Set(false)
						a.openSettingsPane()
						a.openSettingsSection("keys")
					}},
				ui.Button{Text: T("关闭"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "shortcuts-close",
					OnPress: func() { a.shortcutsOpen.Set(false) }},
			},
		}
	})
}

// shortcutsIcon is the command's icon.
var shortcutsIcon = lucide.Keyboard
