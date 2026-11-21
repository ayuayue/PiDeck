//go:build !js && !android && !ios

package workbench

// The plugin market's dialog: a link to an index, the plugins it lists,
// and one-click installs of their manifests.

import (
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// pluginMarketDialog draws the market.
func (a *app) pluginMarketDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		list := a.marketList.Get()
		busy := a.marketBusy.Get()
		if a.plugins != nil {
			a.plugins.Get() // rebuild when an install finishes
		}
		var rows []core.Node
		for _, e := range list {
			entry := e
			installed := a.installedPlugin(entry.ID)
			meta := entry.Version
			if entry.Runtime != "" {
				meta = strings.TrimSpace(meta + " · " + entry.Runtime)
			}
			if entry.Author != "" {
				meta = strings.TrimSpace(meta + " · " + entry.Author)
			}
			texts := []core.Node{
				core.Text{Content: entry.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
			}
			if entry.Description != "" {
				texts = append(texts, core.Text{Content: entry.Description, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Muted)})
			}
			if meta != "" {
				texts = append(texts, core.Text{Content: meta, MaxLines: 1,
					Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)})
			}
			row := []core.Node{
				ui.Icon(lucide.Bot, 14, colors.Muted),
				core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: texts},
			}
			if entry.External {
				row = append(row, ui.Button{Text: apptext.T("打开项目"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "market-project-" + entry.ID, OnPress: func() { a.cx.OpenURL(entry.URL, nil) }})
			} else if installed != nil {
				label := apptext.T("已安装")
				if installed.Version != "" {
					label += " v" + installed.Version
				}
				row = append(row, core.View{Style: core.Style{Padding: core.Symmetric(1, 6), CornerRadius: 4, Background: colors.Inset()},
					Children: []core.Node{ui.Text(label, 9, ui.Medium, colors.Faint)}})
				if entry.Version != "" && installed.Version != "" && entry.Version != installed.Version {
					row = append(row, ui.Button{Text: apptext.T("更新到 %s", entry.Version), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						TestID: "market-update-" + entry.ID, Disabled: a.pluginFileBusy.Get,
						OnPress: func() { a.installFromMarket(entry) }})
				}
			} else {
				row = append(row, ui.Button{Text: apptext.T("安装"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
					TestID: "market-install-" + entry.ID, Disabled: a.pluginFileBusy.Get,
					OnPress: func() { a.installFromMarket(entry) }})
			}
			rows = append(rows, core.View{TestID: "market-entry-" + entry.ID,
				Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, MinHeight: core.Pt(48),
					Padding: core.Symmetric(4, 6)}, Children: row})
		}
		var status core.Node
		switch {
		case busy:
			status = core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
				ui.Spinner{Size: 12}, ui.Text(apptext.T("正在读取索引…"), 11.5, ui.Regular, colors.Muted)}}
		case a.marketErr.Get() != "":
			status = core.Text{Content: a.marketErr.Get(), MaxLines: 3, Style: core.Style{FontSize: 11, LineHeight: 16},
				StyleFunc: ui.Colored(colors.Danger)}
		case len(list) == 0:
			status = core.Text{Content: apptext.T("填一个索引链接，加载后就能安装。索引是 {plugins:[{id,name,url}]} 或一个数组。"),
				Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Faint)}
		}
		return ui.Dialog{
			Open: a.marketOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) {
				if !open {
					a.closePluginMarket()
				}
			},
			Title:  apptext.T("插件市场"),
			TestID: "plugin-market",
			Style:  core.Style{Width: a.dialogWidth(), MaxHeight: core.Pt(660)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 10}, Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: []core.Node{
					ui.Button{Text: apptext.T("内置示例"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "market-examples",
						OnPress: a.showBuiltinPluginExamples},
					ui.Button{Text: apptext.T("官方索引"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "market-official", OnPress: func() { a.discoverPlugins(false) }},
					ui.Button{Text: apptext.T("GitHub 社区"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "market-community", OnPress: func() { a.discoverPlugins(true) }},
				}},
				ui.Text(apptext.T("Lite 条目可安装声明式清单；其他运行时仅打开项目。内置示例可离线安装。"), 11, ui.Regular, colors.Muted),
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
						core.Input{Value: a.marketURL.Get, OnChange: a.marketURL.Set, Placeholder: "https://…/plugins.json",
							Label: apptext.T("索引链接"), TestID: "market-url", AutoFocus: true,
							OnSubmit: func(string) { a.loadPluginIndex() },
							Style: core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 9), FontSize: 11.5, FontFamily: viewkit.MonoFont(), Color: colors.Text(),
								Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 7}},
					}},
					ui.Button{Text: apptext.T("加载"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "market-load",
						OnPress: a.loadPluginIndex},
				}},
				status,
				core.Scroll{Style: core.Style{MaxHeight: core.Pt(400)}, Children: []core.Node{
					core.View{Style: core.Style{Gap: 1}, Children: rows}}},
			}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "market-close",
					OnPress: a.closePluginMarket},
			},
		}
	})
}
