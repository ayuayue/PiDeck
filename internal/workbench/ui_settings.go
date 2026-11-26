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
	Group   string
}

// settingsSections are the sections, in order.
func settingsSections() []settingsSection {
	return []settingsSection{
		{"general", "通用", lucide.Settings2, "通用", "语言、布局、会话默认值，以及通知和提示音。", "偏好设置"},
		{"look", "外观", lucide.Palette, "外观", "主题配色、文字大小、字体和背景。", "偏好设置"},
		{"keys", "快捷键", lucide.Keyboard, "快捷键", "每个命令的快捷键；留空则不绑定，改坏了可以恢复默认。", "偏好设置"},
		{"models", "模型与供应商", lucide.Cpu, "模型与供应商", "供应商提供模型服务；这里管理连接信息、常用模型及翻译与提示词增强使用的模型。", "模型与运行"},
		{"credentials", "登录与密钥", lucide.KeyRound, "登录与密钥", "管理 pi 使用的登录凭据和 API 密钥。", "模型与运行"},
		{"pi", "pi 设置", lucide.Settings, "pi 设置", "pi 是运行会话的 AI 助手；这里管理它的 settings.json 设置。", "模型与运行"},
		{"env", "运行环境", lucide.Terminal, "运行环境", "检查 pi 安装状态，配置本机、WSL 或 SSH 运行环境。", "模型与运行"},
		{"mcp", "MCP 工具", lucide.Plug, "MCP 服务器", "MCP 是连接外部工具的协议；这里管理 pi 可用的工具服务器。", "扩展与连接"},
		{"resources", "技能与扩展", lucide.Package, "技能与扩展", "查看和管理 pi 的技能说明、提示词模板与扩展能力。", "扩展与连接"},
		{"addons", "插件", lucide.Puzzle, "插件", "管理 PiDeck 插件，为命令面板和外观添加功能。", "扩展与连接"},
		{"integrations", "集成与自动化", lucide.Webhook, "集成与自动化", "语音输入、外部消息、智能体与定时任务的连接设置。", "扩展与连接"},
		{"remote", "手机与远程", lucide.Globe, "远程访问", "让手机连接这台电脑上的项目和会话。", "扩展与连接"},
		{"usage", "用量统计", lucide.ChartColumn, "用量统计", "按模型和项目统计会话用量及估算费用；Token 是模型处理内容的计量单位。", "数据与维护"},
		{"data", "数据管理", lucide.HardDrive, "数据管理", "查看数据位置，备份或恢复设置，并管理缓存与同步。", "数据与维护"},
		{"diagnostics", "诊断", lucide.Stethoscope, "诊断", "运行中的进程、内存与最近的日志。", "数据与维护"},
		{"about", "关于", lucide.Info, "关于", "版本、许可与来源。", "数据与维护"},
	}
}

// settingsPane is the settings page: its rail beside the section's rows.
func (a *app) settingsPane() core.Node {
	colors := ui.ColorsOf(a.cx)
	var groups []string
	rowsByGroup := map[string][]core.Node{}
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
					core.Text{Content: apptext.T(s.Label), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FontSize: 12.5, FlexShrink: 1, MinWidth: core.Pt(0)},
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
		if _, exists := rowsByGroup[s.Group]; !exists {
			groups = append(groups, s.Group)
		}
		rowsByGroup[s.Group] = append(rowsByGroup[s.Group], row)
	}
	group := func(label string, rows []core.Node) core.Node {
		return core.View{Style: core.Style{Gap: 2}, Children: append([]core.Node{
			core.Text{Content: apptext.T(label), Role: core.RoleHeader,
				Style:     core.Style{FontSize: 11, FontWeight: ui.Semibold, Padding: core.Edges{Left: 9, Top: 6, Bottom: 4}},
				StyleFunc: ui.Colored(colors.Muted)},
		}, rows...)}
	}
	var nav []core.Node
	for _, title := range groups {
		nav = append(nav, group(title, rowsByGroup[title]))
	}
	return core.View{TestID: "settings", StyleFunc: func() core.Style {
		return core.Style{Direction: core.Row, FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), MinWidth: core.Pt(0),
			Background: colors.Background()}
	}, Children: []core.Node{
		// rail
		core.View{StyleFunc: func() core.Style {
			return core.Style{Width: core.Pt(200), Padding: core.All(10), Gap: 2, FlexShrink: 0,
				Background: colors.Inset(), Borders: core.Edges{Right: 1}, BorderColors: core.EdgeColors{Right: colors.Now().Line}}
		}, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Left: 9, Top: 4, Bottom: 8}}, Children: []core.Node{
				ui.Text(apptext.T("设置"), 13, ui.Semibold, colors.Text),
			}},
			core.View{Style: core.Style{Padding: core.Edges{Left: 1, Right: 1, Bottom: 8}}, Children: []core.Node{
				a.settingsSearchField(colors),
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

// settingsSearchField finds a setting by name: the icon, the query, and a
// clear button once there is something to clear.
func (a *app) settingsSearchField(colors ui.Colors) core.Node {
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, Height: core.Pt(26),
		Padding: core.Symmetric(0, 6), CornerRadius: 6, Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder()},
		Children: []core.Node{
			ui.Icon(lucide.Search, 11, colors.Faint),
			core.Input{Ref: a.settingsFieldRef(), Value: a.settingsQuery.Get, OnChange: a.settingsQuery.Set, OnSubmit: a.submitSettingsSearch,
				Role: core.RoleSearchField, Placeholder: apptext.T("搜索设置"), Label: apptext.T("搜索设置"), TestID: "settings-search",
				Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0), Height: core.Pt(20), FontSize: 11, LineHeight: 16, Color: colors.Text()},
				StyleFunc: func() core.Style {
					return core.Style{PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
				}},
			core.Show{When: func() bool { return a.settingsQuery.Get() != "" }, Then: func(*core.Scope) core.Node {
				return ui.IconButton{Icon: lucide.X, Label: apptext.T("清空搜索"), Size: 18, IconSize: 11, TestID: "settings-clear",
					Tint: func() core.Color { return colors.Faint() }, OnPress: a.clearSettingsSearch}
			}},
		}}
}

// settingsFieldRef is the search field, made on first use.
func (a *app) settingsFieldRef() *core.Ref {
	if a.settingsField == nil {
		a.settingsField = new(core.Ref)
	}
	return a.settingsField
}

// clearSettingsSearch empties the query and keeps the keyboard in the field.
func (a *app) clearSettingsSearch() {
	a.settingsQuery.Set("")
	if a.settingsField != nil {
		a.settingsField.Focus()
	}
}

// submitSettingsSearch opens the first setting the query names, as Return
// does in the command palette.
func (a *app) submitSettingsSearch(string) {
	if hits := searchSettings(a.settingsQuery.GetUntracked()); len(hits) > 0 {
		a.openSettingsSection(hits[0].Section)
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
			hint := apptext.T(settingsSectionTitle(entry.Section))
			if entry.Jump {
				hint = apptext.T("跳到分区")
			}
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
					core.Text{Content: hint, MaxLines: 1, Style: core.Style{FontSize: 9.5, FlexShrink: 0},
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
			return a.settingsDiagnostics(cx)
		case "data":
			return a.settingsData()
		case "about":
			return a.settingsAbout()
		}
		return a.settingsGeneral()
	})
}
