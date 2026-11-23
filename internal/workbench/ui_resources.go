//go:build !js && !android && !ios

package workbench

// The resources page: pi's skills, each opening its SKILL.md, and the
// extensions pi loads, with the switch that turns one off.

import (
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// settingsResources shows pi's skills and extensions.
func (a *app) settingsResources() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		a.settingsTick()
		colors := ui.ColorsOf(cx)
		if a.resourcesLoading.Get() && !a.resourcesLoaded {
			return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 8},
				Children: []core.Node{ui.Spinner{Size: 16}, ui.Text(apptext.T("正在读取技能与扩展…"), 11.5, ui.Regular, colors.Muted)}}
		}
		r := a.resources.Get()
		var skillRows []core.Node
		for _, skill := range r.Skills {
			sk := skill
			desc := sk.Description
			if desc == "" && sk.Error != "" {
				desc = sk.Error
			}
			skillRows = append(skillRows, core.View{
				OnPress: func(core.PressEvent) { a.openSkill(sk) },
				Role:    core.RoleButton, Label: apptext.T("技能 ") + sk.Name, TestID: "skill-row",
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, MinHeight: core.Pt(42),
						Padding: core.Symmetric(4, 2), CornerRadius: 6, Hover: &core.Style{Background: colors.Hover()},
						Transition: viewkit.PressMotion}
				},
				Children: []core.Node{
					ui.Icon(lucide.Sparkles, 13, colors.Muted),
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
						core.Text{Content: sk.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{FontSize: 12}, StyleFunc: ui.Colored(colors.Text)},
						core.Show{When: func() bool { return desc != "" }, Then: func(*core.Scope) core.Node {
							return core.Text{Content: desc, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
								Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Muted)}
						}},
						core.Text{Content: shortPath(sk.Dir, 58), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9}, StyleFunc: ui.Colored(colors.Faint)},
					}},
					ui.Icon(lucide.FileText, 12, colors.Faint),
				},
			})
		}
		if len(skillRows) == 0 {
			skillRows = append(skillRows, core.Text{Content: apptext.T("没有读到技能；技能放在 pi 配置目录的 skills 下。"),
				Style: core.Style{FontSize: 11, Padding: core.Symmetric(6, 2)}, StyleFunc: ui.Colored(colors.Faint)})
		}
		var extRows []core.Node
		for _, ext := range r.Extensions {
			ex := ext
			var badge string
			switch {
			case ex.Builtin:
				badge = "内置"
			case ex.Local:
				badge = "本地文件"
			default:
				badge = "npm"
			}
			var control core.Node
			if ex.Toggleable {
				control = ui.Switch{Checked: func() bool { return ex.Enabled }, Label: apptext.T("启用 ") + ex.Source,
					Size: ui.SizeSmall, TestID: "extension-toggle-" + strings.ReplaceAll(ex.Bare, ":", "-"),
					OnChange: func(on bool) { a.toggleExtension(ex.Bare, on) }}
			} else {
				control = ui.Text(apptext.T("自动加载"), 10, ui.Regular, colors.Faint)
			}
			extRows = append(extRows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9,
				MinHeight: core.Pt(38), Padding: core.Symmetric(3, 2)}, Children: []core.Node{
				ui.Icon(lucide.Blocks, 13, colors.Muted),
				core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
					core.Text{Content: ex.Source, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11}, StyleFunc: ui.Colored(colors.Text)},
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
						ui.Text(badge, 9.5, ui.Regular, colors.Faint),
						core.Show{When: func() bool { return ex.Path != "" }, Then: func(*core.Scope) core.Node {
							return core.Text{Content: shortPath(ex.Path, 52), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
								Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9}, StyleFunc: ui.Colored(colors.Faint)}
						}},
					}},
				}},
				control,
			}})
		}
		if len(extRows) == 0 {
			extRows = append(extRows, core.Text{Content: apptext.T("没有读到扩展。"),
				Style: core.Style{FontSize: 11, Padding: core.Symmetric(6, 2)}, StyleFunc: ui.Colored(colors.Faint)})
		}
		children := []core.Node{
			setGroup("技能", skillRows...),
			setGroup("扩展", extRows...),
		}
		if r.Err != "" {
			children = append(children, core.Text{Content: r.Err, Style: core.Style{FontSize: 10.5},
				StyleFunc: ui.Colored(colors.Danger)})
		}
		children = append(children, core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6, Margin: core.Edges{Top: 2}},
			Children: []core.Node{
				ui.Button{Text: apptext.T("技能商店…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "skill-store-open",
					OnPress: func() { a.openSkillStore() }},
				ui.Button{Text: apptext.T("扩展商店…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "pi-store-open",
					OnPress: func() { a.openPiExtensionStore() }},
				ui.Button{Text: apptext.T("打开技能目录"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() {
					if dirs := skillsDirs(); len(dirs) > 0 {
						a.openResourcesDir(dirs[0])
					}
				}},
				ui.Button{Text: apptext.T("打开扩展目录"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() {
					a.openResourcesDir(extensionsDir())
				}},
				ui.Button{Text: apptext.T("更新内置扩展"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "pi-ext-update",
					Busy: a.piExtUpdateBusy.Get, OnPress: a.updateBundledPiExtensions},
				ui.Button{Text: apptext.T("重新读取"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
					a.resourcesLoaded = false
					a.loadResources(true)
				}},
			}})
		return a.scrollStashFor("settingsResources:1").bind(cx, core.Scroll{TestID: "settings-page", Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: 2}, Gap: 4}, Children: children},
		}})
	})
}
