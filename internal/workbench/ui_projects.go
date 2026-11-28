//go:build !js && !android && !ios

package workbench

// The project group dialog: a name, with the groups already in use as
// suggestions.

import (
	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// projectGroupDialog names the group a project belongs to.
func (a *app) projectGroupDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		var chips []core.Node
		chip := func(label, value string) core.Node {
			return core.View{OnPress: func(core.PressEvent) { a.projectGroupText.Set(value) },
				Role: core.RoleRadio, Label: label,
				StyleFunc: func() core.Style {
					st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Height: core.Pt(24),
						Padding: core.Symmetric(0, 9), CornerRadius: 12, BorderWidth: 1, BorderColor: colors.Border(),
						Hover: &core.Style{Background: colors.Hover()}}
					if a.projectGroupText.Get() == value {
						st.Background = colors.Pressed()
						st.BorderColor = colors.Text()
					}
					return st
				},
				Children: []core.Node{ui.Text(label, 11.5, ui.Regular, colors.Text)}}
		}
		chips = append(chips, chip(apptext.T("未分组"), ""))
		for _, g := range a.projectGroupNames() {
			chips = append(chips, chip(g, g))
		}
		return ui.Dialog{
			Open:         a.projectGroupOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.projectGroupOpen.Set(open) },
			Title:        apptext.T("移动到分组"),
			TestID:       "project-group",
			Style:        core.Style{Width: core.Pt(420)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 10}, Children: []core.Node{
				core.Text{Content: apptext.T("给项目起一个分组名；留空就是未分组。"), Style: core.Style{FontSize: 11.5},
					StyleFunc: ui.Colored(colors.Muted)},
				core.Input{Value: a.projectGroupText.Get, OnChange: a.projectGroupText.Set, Placeholder: apptext.T("分组名"),
					Label: apptext.T("分组名"), TestID: "project-group-input", AutoFocus: true,
					OnSubmit: func(string) { a.saveProjectGroup() },
					Style: core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 9), CornerRadius: 7,
						Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(),
						Color: colors.Text(), FontSize: 12.5}},
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: chips},
			}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.projectGroupOpen.Set(false) }},
				ui.Button{Text: apptext.T("保存"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "project-group-save",
					OnPress: func() { a.saveProjectGroup() }},
			},
		}
	})
}
