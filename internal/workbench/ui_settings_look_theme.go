//go:build !js && !android && !ios

package workbench

import (
	"strings"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) lookAppearanceMode() string {
	id := a.theme.Get()
	if spec := a.themeSpec(id); spec != nil && (spec.Appearance == "light" || spec.Appearance == "dark") {
		return spec.Appearance
	}
	if id == "light" || id == "dark" {
		return id
	}
	return a.cfg.Appearance
}

func (a *app) lookThemeSettings() core.Node {
	// Theme discovery updates this region without discarding font drafts.
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		var choices []core.Node
		for _, spec := range a.themes.Get() {
			if spec.ID == "light" || spec.ID == "dark" {
				continue
			}
			s := spec
			name, note := apptext.T(s.Name), s.Author
			if s.ID == "system" {
				name = apptext.T("默认配色")
			}
			if s.Error != "" {
				note = apptext.T("读取失败") + " · " + s.Error
			} else if s.Appearance == "light" {
				note = apptext.T("仅浅色")
			} else if s.Appearance == "dark" {
				note = apptext.T("仅深色")
			}
			children := []core.Node{ui.Radio{
				Label: name, TestID: "theme-" + s.ID,
				Checked: func() bool {
					id := a.theme.Get()
					return id == s.ID || (s.ID == "system" && (id == "light" || id == "dark"))
				}, Disabled: func() bool { return s.Error != "" },
				OnChange: func(bool) { a.setLook(s.ID, a.lookAppearanceMode()); a.bumpSettings() },
				Style:    core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), MinHeight: core.Pt(38), Padding: core.All(4), Gap: 8},
				Children: []core.Node{themePreview(s), core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
					core.Text{Content: name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail, Style: core.Style{FontSize: 12}, StyleFunc: ui.Colored(colors.Text)},
					core.Text{Content: note, MaxLines: 1, EllipsizeMode: core.EllipsizeTail, Style: core.Style{FontSize: 10}, StyleFunc: ui.Colored(colors.Muted)},
				}}},
			}}
			if !s.Builtin && s.Source != "" {
				children = append(children, ui.Button{Text: apptext.T("删除"), Label: apptext.T("删除主题") + " " + name,
					Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "theme-delete-" + strings.ReplaceAll(s.ID, ":", "-"),
					OnPress: func() { a.deleteTheme(s) }})
			}
			choices = append(choices, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter,
				Width: core.Pt(260), MaxWidth: core.Pct(100), FlexShrink: 1, MinWidth: core.Pt(0), Gap: 4}, Children: children})
		}
		fixed := func() bool {
			spec := a.themeSpec(a.theme.Get())
			return spec != nil && (spec.Appearance == "light" || spec.Appearance == "dark")
		}
		help := "跟随系统，或固定使用浅色、深色；切换配色会保留此选择。"
		if fixed() {
			help = "当前主题仅提供一种明暗模式；选择其他配色后可调整。"
		}
		return setGroup("主题与动效",
			setRow("明暗模式", help, ui.Select[string]{
				Options: []ui.Option[string]{{Value: "", Label: apptext.T("跟随系统")}, {Value: "light", Label: apptext.T("浅色")}, {Value: "dark", Label: apptext.T("深色")}},
				Value:   a.lookAppearanceMode, Disabled: fixed, Label: apptext.T("明暗模式"), TestID: "look-appearance", Style: settingsSelectStyle(),
				OnChange: func(side string) {
					id := a.theme.GetUntracked()
					if id == "light" || id == "dark" {
						id = "system"
					}
					a.setLook(id, side)
					a.bumpSettings()
				}}),
			setDivider(),
			setRow("配色", "选择配色风格；仅浅色或仅深色的主题会固定明暗模式。", nil),
			ui.RadioGroup{Label: apptext.T("配色"), TestID: "look-palettes", Horizontal: true,
				Style: core.Style{ColumnGap: 12, RowGap: 2, Padding: core.Edges{Bottom: 4}}, Children: choices},
			setDivider(),
			setRow("减弱动效", "关闭工作台布局和对话定位的动画。", ui.Switch{
				Checked: a.reduceEffects.Get, Label: apptext.T("减弱动效"), TestID: "reduce-effects",
				OnChange: func(on bool) {
					a.reduceEffects.Set(on)
					a.cfg.ReduceEffects = on
					if a.st != nil {
						a.st.change(func(c *config) { c.ReduceEffects = on })
						a.saveConfigAsync()
					}
				}}),
		)
	})
}
