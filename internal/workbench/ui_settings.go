//go:build !js && !android && !ios

package workbench

// The settings window: a rail of sections beside the section's rows. Each
// row says what it is in a line and why in a quieter one, and the control
// sits at its end, so a section reads top to bottom.

import (
	"fmt"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// settingsSection is one entry of the settings rail.
type settingsSection struct {
	ID      string
	Label   string
	Icon    func() *core.SVG
	Title   string
	Summary string
	Config  bool
}

// settingsSections are the sections, in order.
func settingsSections() []settingsSection {
	return []settingsSection{
		{"general", "通用", lucide.Settings2, "通用", "新会话的默认值，以及侧栏读什么。", false},
		{"models", "模型与认证", lucide.Cpu, "模型与认证", "pi 认识哪些供应商、各自有多少模型、凭据是否可用。", true},
		{"credentials", "pi 凭据", lucide.KeyRound, "pi 凭据", "pi 先看 auth.json，再看 models.json 的 apiKey，最后看环境变量。", true},
		{"pi", "pi 设置", lucide.Settings, "pi 设置", "编辑 settings.json", true},
		{"usage", "用量", lucide.ChartColumn, "用量", "从本地会话文件统计 token、费用、模型与项目分布。", false},
		{"keys", "键位", lucide.Keyboard, "键位", "每个命令的快捷键；留空则不绑定，改坏了可以恢复默认。", false},
		{"look", "外观", lucide.Palette, "外观", "配色与主题文件。", false},
		{"remote", "远程", lucide.Globe, "远程访问", "让手机连接这台电脑上的项目和会话。", true},
		{"env", "环境", lucide.Terminal, "环境", "pi 在哪里、能不能用；WSL 与 SSH 目标。", true},
		{"mcp", "MCP", lucide.Plug, "MCP 服务器", "给 pi 挂上外部工具服务器；列表与增删走 pi mcp。", true},
		{"addons", "插件", lucide.Puzzle, "插件", "插件给命令面板加命令，给外观加主题。", true},
		{"resources", "资源", lucide.Package, "资源", "pi 的技能与扩展：看它们做什么，打开或停用。", true},
		{"integrations", "集成", lucide.Webhook, "集成", "把一轮完成的消息发到飞书群。", true},
		{"diagnostics", "诊断", lucide.Stethoscope, "诊断", "运行中的进程、内存与最近的日志。", false},
		{"data", "数据", lucide.HardDrive, "数据", "会话与配置在磁盘上的位置。", false},
		{"about", "关于", lucide.Info, "关于", "版本、许可与来源。", false},
	}
}

// settingsPane is the settings page: its rail beside the section's rows.
func (a *app) settingsPane() core.Node {
	colors := ui.ColorsOf(a.cx)
	var system, config []core.Node
	for _, sec := range settingsSections() {
		s := sec
		on := func() bool { return a.settingsTab.Get() == s.ID }
		row := core.Dynamic(func(cx *core.Scope) core.Node {
			_ = a.langRev.Get()
			colors := ui.ColorsOf(cx)
			return base.Tab{
				OnPress:  func(core.PressEvent) { a.openSettingsSection(s.ID) },
				Selected: on, Label: apptext.T(s.Label), TestID: "settings-tab-" + s.ID,
				StyleFunc: func() core.Style {
					st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(30),
						Padding: core.Symmetric(0, 9), CornerRadius: 7, Hover: &core.Style{Background: colors.Hover()},
						FocusVisible: ui.FocusRing(cx, -2)}
					if on() {
						st.Background = colors.Pressed()
					}
					return st
				},
				Children: []core.Node{
					ui.IconOf(s.Icon, 13.5, func() core.Color {
						if on() {
							return colors.Text()
						}
						return colors.Muted()
					}),
					core.Text{Content: apptext.T(s.Label), Style: core.Style{FontSize: 12.5},
						StyleFunc: func() core.Style {
							w := ui.Regular
							if on() {
								w = ui.Semibold
							}
							return core.Style{Color: colors.Text(), FontWeight: w}
						}},
				},
			}
		})
		if s.Config {
			config = append(config, row)
		} else {
			system = append(system, row)
		}
	}
	group := func(label string, rows []core.Node) core.Node {
		return core.View{Style: core.Style{Gap: 2}, Children: append([]core.Node{
			core.Text{Content: apptext.T(label), Role: core.RoleHeader,
				Style:     core.Style{FontSize: 11, FontWeight: ui.Semibold, Padding: core.Edges{Left: 9, Top: 6, Bottom: 4}},
				StyleFunc: ui.Colored(colors.Muted)},
		}, rows...)}
	}
	nav := []core.Node{group("系统设置", system), group("配置管理", config)}
	return core.View{TestID: "settings", StyleFunc: func() core.Style {
		return core.Style{Direction: core.Row, FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), MinWidth: core.Pt(0),
			Background: colors.Background()}
	}, Children: []core.Node{
		// rail
		core.View{StyleFunc: func() core.Style {
			return core.Style{Width: core.Pt(176), Padding: core.All(10), Gap: 2, FlexShrink: 0,
				Background: colors.Inset(), Borders: core.Edges{Right: 1}, BorderColors: core.EdgeColors{Right: colors.Now().Line}}
		}, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Left: 9, Top: 4, Bottom: 8}}, Children: []core.Node{
				ui.Text(apptext.T("设置"), 13, ui.Semibold, colors.Text),
			}},
			core.View{Style: core.Style{Padding: core.Edges{Left: 1, Right: 1, Bottom: 8}}, Children: []core.Node{
				core.Input{Value: a.settingsQuery.Get, OnChange: a.settingsQuery.Set, Placeholder: apptext.T("搜索设置"),
					Label: apptext.T("搜索设置"), TestID: "settings-search",
					Style: core.Style{Height: core.Pt(26), Padding: core.Symmetric(0, 8), FontSize: 11, Color: colors.Text(),
						Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 6,
						PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}},
			}},
			a.settingsRail(nav),
		}},
		// content
		core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), MinHeight: core.Pt(0), Direction: core.Column}, Children: []core.Node{
			core.Dynamic(func(cx *core.Scope) core.Node {
				_ = a.langRev.Get()
				sec := settingsSections()[0]
				for _, s := range settingsSections() {
					if s.ID == a.settingsTab.Get() {
						sec = s
					}
				}
				return core.View{Style: core.Style{Gap: 2, Padding: core.Edges{Top: 16, Right: 20, Bottom: 8, Left: 20}}, Children: []core.Node{
					ui.Text(apptext.T(sec.Title), 15, ui.Semibold, colors.Text),
					core.Text{Content: apptext.T(sec.Summary), Style: core.Style{FontSize: 11.5, LineHeight: 17}, StyleFunc: ui.Colored(colors.Muted)},
				}}
			}),
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), MinHeight: core.Pt(0), Padding: core.Edges{Right: 20, Left: 20}}, Children: []core.Node{
				a.settingsContent(),
			}},
			core.View{StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Symmetric(10, 16),
					FlexShrink: 0, Borders: core.Edges{Top: 1}, BorderColors: core.EdgeColors{Top: colors.Now().Line}}
			}, Children: []core.Node{
				ui.Button{Text: apptext.T("重新检测"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: a.reloadFrameworks},
				core.View{Style: core.Style{FlexGrow: 1}},
				ui.Button{Text: apptext.T("完成"), Variant: ui.ButtonPrimary, TestID: "settings-done", OnPress: func() { a.closePane(paneSettings) }},
			}},
		}},
	}}
}

// openSettingsPane shows the settings page in the work area, on the section
// it was last left on: its loader runs here, since a restored section never
// went through openSettingsSection.
func (a *app) openSettingsPane() {
	a.openPane(paneSettings)
	a.loadSettingsSection(a.settingsTab.GetUntracked())
}

// openSettingsSection switches to a section and runs its loader.
func (a *app) openSettingsSection(id string) {
	a.settingsTab.Set(id)
	a.forgetScrolls("settings")
	if a.st != nil && a.cfg.SettingsTab != id {
		a.cfg.SettingsTab = id
		a.st.edit(func(c *config) { c.SettingsTab = id })
	}
	a.settingsQuery.Set("")
	a.loadSettingsSection(id)
}

// loadSettingsSection runs the loader a section needs before it can show
// anything.
func (a *app) loadSettingsSection(id string) {
	switch id {
	case "remote":
		if a.remote != nil {
			a.remote.refresh()
		}
	case "models":
		// The built-in account's balance is a network read, so it refreshes
		// when the section opens rather than on every redraw.
		a.tdRefresh()
	case "credentials":
		a.loadAuth()
	case "usage":
		a.loadUsage(false)
	case "resources":
		a.loadResources(false)
	case "mcp":
		a.loadMCPServers(true)
	case "diagnostics":
		// The page reads figures the tick fills, so fill them before it
		// shows rather than after the first pass.
		a.diagRefresh()
	}
}

// settingsRail is the section list, or the search results while a query is
// being typed.
func (a *app) settingsRail(nav []core.Node) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		a.langRev.Get()
		colors := ui.ColorsOf(cx)
		query := strings.ToLower(strings.TrimSpace(a.settingsQuery.Get()))
		if query == "" {
			return a.scrollStashFor("settingsRail:1").Bind(cx, core.Scroll{TestID: "settings-navigation", Style: ui.FillRest,
				Children: []core.Node{base.Tabs{Label: apptext.T("设置"), Style: core.Style{Gap: 8}, Children: nav}}})
		}
		hits := searchSettings(query)
		if len(hits) == 0 {
			return a.scrollStashFor("settingsRail:2").Bind(cx, core.Scroll{TestID: "settings-search-results", Style: ui.FillRest,
				Children: []core.Node{core.Text{Content: apptext.T("没有匹配的设置"), Style: core.Style{FontSize: 11, Padding: core.Symmetric(6, 8)},
					StyleFunc: ui.Colored(colors.Faint)}}})
		}
		bySection := map[string]int{}
		var rows []core.Node
		for _, e := range hits {
			entry := e
			n := bySection[entry.Section]
			bySection[entry.Section] = n + 1
			rows = append(rows, core.View{
				OnPress: func(core.PressEvent) { a.openSettingsSection(entry.Section) },
				Role:    core.RoleButton, Label: apptext.T(entry.Label),
				TestID: fmt.Sprintf("settings-hit-%s-%d", entry.Section, n),
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Height: core.Pt(26),
						Padding: core.Symmetric(0, 8), CornerRadius: 6, Hover: &core.Style{Background: colors.Hover()}}
				},
				Children: []core.Node{
					core.Text{Content: apptext.T(entry.Label), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11.5}, StyleFunc: ui.Colored(colors.Text)},
					core.Text{Content: apptext.T(settingsSectionTitle(entry.Section)), MaxLines: 1, Style: core.Style{FontSize: 9.5, FlexShrink: 0},
						StyleFunc: ui.Colored(colors.Faint)},
				},
			})
		}
		return a.scrollStashFor("settingsRail:3").Bind(cx, core.Scroll{TestID: "settings-search-results", Style: ui.FillRest,
			Children: []core.Node{core.View{Style: core.Style{Gap: 1}, Children: rows}}})
	})
}

// settingsContent picks the section's body.
func (a *app) settingsContent() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		// The language and settings revisions make every page rebuild after
		// a switch.
		_ = a.langRev.Get()
		if a.settingsRev != nil {
			a.settingsTick()
		}
		switch a.settingsTab.Get() {
		case "models":
			return a.settingsModels()
		case "credentials":
			return a.settingsCredentials()
		case "pi":
			return a.settingsPi()
		case "usage":
			return a.settingsUsage()
		case "keys":
			return a.settingsKeys()
		case "look":
			return a.settingsLook()
		case "remote":
			return a.settingsRemote()
		case "env":
			return a.settingsEnv()
		case "mcp":
			return a.settingsMCP()
		case "addons":
			return a.settingsAddons()
		case "resources":
			return a.settingsResources()
		case "integrations":
			return a.settingsIntegrations()
		case "diagnostics":
			return a.settingsDiagnostics()
		case "data":
			return a.settingsData()
		case "about":
			return a.settingsAbout()
		}
		return a.settingsGeneral()
	})
}
