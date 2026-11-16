package main

// The settings window: a rail of sections beside the section's rows. Each
// row says what it is in a line and why in a quieter one, and the control
// sits at its end, so a section reads top to bottom.

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/updater"
)

// settingsSection is one entry of the settings rail.
type settingsSection struct {
	ID      string
	Label   string
	Icon    func() *core.SVG
	Title   string
	Summary string
}

// settingsSections are the sections, in order.
func settingsSections() []settingsSection {
	return []settingsSection{
		{"general", "通用", lucide.Settings2, "通用", "新会话的默认值，以及侧栏读什么。"},
		{"models", "模型与认证", lucide.Cpu, "模型与认证", "pi 认识哪些供应商、各自有多少模型、凭据是否可用。"},
		{"usage", "用量", lucide.ChartColumn, "用量", "从本地会话文件统计 token、费用、模型与项目分布。"},
		{"keys", "键位", lucide.Keyboard, "键位", "每个命令的快捷键；留空则不绑定，改坏了可以恢复默认。"},
		{"look", "外观", lucide.Palette, "外观", "配色与主题文件。"},
		{"remote", "远程", lucide.Globe, "远程访问", "让手机连接这台电脑上的项目和会话。"},
		{"env", "环境", lucide.Terminal, "环境", "pi 在哪里、能不能用；WSL 与 SSH 目标。"},
		{"mcp", "MCP", lucide.Plug, "MCP 服务器", "给 pi 挂上外部工具服务器；列表与增删走 pi mcp。"},
		{"addons", "插件", lucide.Puzzle, "插件", "插件给命令面板加命令，给外观加主题。"},
		{"resources", "资源", lucide.Package, "资源", "pi 的技能与扩展：看它们做什么，打开或停用。"},
		{"integrations", "集成", lucide.Webhook, "集成", "把一轮完成的消息发到飞书群。"},
		{"diagnostics", "诊断", lucide.Stethoscope, "诊断", "运行中的进程、内存与最近的日志。"},
		{"data", "数据", lucide.HardDrive, "数据", "会话与配置在磁盘上的位置。"},
		{"about", "关于", lucide.Info, "关于", "版本、许可与来源。"},
	}
}

// settingsDialog is the settings window.
func (a *app) settingsDialog() core.Node {
	colors := ui.ColorsOf(a.cx)
	nav := make([]core.Node, 0, len(settingsSections()))
	for _, sec := range settingsSections() {
		s := sec
		on := func() bool { return a.settingsTab.Get() == s.ID }
		nav = append(nav, core.Dynamic(func(cx *core.Scope) core.Node {
			_ = a.langRev.Get()
			colors := ui.ColorsOf(cx)
			return core.View{
				OnPress: func(core.PressEvent) { a.openSettingsSection(s.ID) },
				Role:    core.RoleTab, Label: T(s.Label), TestID: "settings-tab-" + s.ID,
				StyleFunc: func() core.Style {
					st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(30),
						Padding: core.Symmetric(0, 9), CornerRadius: 7, Hover: &core.Style{Background: colors.Hover()}}
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
					core.Text{Content: T(s.Label), Style: core.Style{FontSize: 12.5},
						StyleFunc: func() core.Style {
							w := ui.Regular
							if on() {
								w = ui.Semibold
							}
							return core.Style{Color: colors.Text(), FontWeight: w}
						}},
				},
			}
		}))
	}
	return ui.Dialog{
		Open: a.settings.Get,
		OnOpenChange: func(open bool, _ base.Reason) {
			a.settings.Set(open)
			if !open {
				a.settingsQuery.Set("")
			}
		},
		Bare:   true,
		TestID: "settings",
		Style:  core.Style{Width: core.Pt(760), Height: core.Pt(560)},
		Children: []core.Node{core.View{Style: core.Style{Direction: core.Row, FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0)}, Children: []core.Node{
			// rail
			core.View{StyleFunc: func() core.Style {
				return core.Style{Width: core.Pt(176), Padding: core.All(10), Gap: 2, FlexShrink: 0,
					Background: colors.Inset(), Borders: core.Edges{Right: 1}, BorderColors: core.EdgeColors{Right: colors.Now().Line}}
			}, Children: []core.Node{
				core.View{Style: core.Style{Padding: core.Edges{Left: 9, Top: 4, Bottom: 8}}, Children: []core.Node{
					ui.Text("设置", 13, ui.Semibold, colors.Text),
				}},
				core.View{Style: core.Style{Padding: core.Edges{Left: 1, Right: 1, Bottom: 8}}, Children: []core.Node{
					core.Input{Value: a.settingsQuery.Get, OnChange: a.settingsQuery.Set, Placeholder: T("搜索设置"),
						Label: T("搜索设置"), TestID: "settings-search",
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
						ui.Text(T(sec.Title), 15, ui.Semibold, colors.Text),
						core.Text{Content: T(sec.Summary), Style: core.Style{FontSize: 11.5, LineHeight: 17}, StyleFunc: ui.Colored(colors.Muted)},
					}}
				}),
				core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), Padding: core.Edges{Right: 20, Left: 20}}, Children: []core.Node{
					a.settingsContent(),
				}},
				core.View{StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Symmetric(10, 16),
						FlexShrink: 0, Borders: core.Edges{Top: 1}, BorderColors: core.EdgeColors{Top: colors.Now().Line}}
				}, Children: []core.Node{
					ui.Button{Text: T("重新检测"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: a.reloadFrameworks},
					core.View{Style: core.Style{FlexGrow: 1}},
					ui.Button{Text: T("完成"), Variant: ui.ButtonPrimary, TestID: "settings-done", OnPress: func() { a.settings.Set(false) }},
				}},
			}},
		}}},
	}
}

// openSettingsSection switches to a section and runs its loader.
func (a *app) openSettingsSection(id string) {
	a.settingsTab.Set(id)
	a.settingsQuery.Set("")
	switch id {
	case "remote":
		if a.remote != nil {
			a.remote.refresh()
		}
	case "usage":
		a.loadUsage(false)
	case "resources":
		a.loadResources(false)
	case "mcp":
		a.loadMCPServers(true)
	}
}

// settingsRail is the section list, or the search results while a query is
// being typed.
func (a *app) settingsRail(nav []core.Node) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		query := strings.ToLower(strings.TrimSpace(a.settingsQuery.Get()))
		if query == "" {
			return core.View{Style: core.Style{Gap: 2}, Children: nav}
		}
		hits := searchSettings(query)
		if len(hits) == 0 {
			return core.Text{Content: T("没有匹配的设置"), Style: core.Style{FontSize: 11, Padding: core.Symmetric(6, 8)},
				StyleFunc: ui.Colored(colors.Faint)}
		}
		bySection := map[string]int{}
		var rows []core.Node
		for _, e := range hits {
			entry := e
			n := bySection[entry.Section]
			bySection[entry.Section] = n + 1
			rows = append(rows, core.View{
				OnPress: func(core.PressEvent) { a.openSettingsSection(entry.Section) },
				Role:    core.RoleButton, Label: T(entry.Label),
				TestID: fmt.Sprintf("settings-hit-%s-%d", entry.Section, n),
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Height: core.Pt(26),
						Padding: core.Symmetric(0, 8), CornerRadius: 6, Hover: &core.Style{Background: colors.Hover()}}
				},
				Children: []core.Node{
					core.Text{Content: T(entry.Label), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11.5}, StyleFunc: ui.Colored(colors.Text)},
					core.Text{Content: T(settingsSectionTitle(entry.Section)), MaxLines: 1, Style: core.Style{FontSize: 9.5, FlexShrink: 0},
						StyleFunc: ui.Colored(colors.Faint)},
				},
			})
		}
		return core.Scroll{Style: ui.FillRest, Children: []core.Node{core.View{Style: core.Style{Gap: 1}, Children: rows}}}
	})
}

// settingsContent picks the section's body.
func (a *app) settingsContent() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		// The language revision makes every page rebuild after a switch.
		_ = a.langRev.Get()
		switch a.settingsTab.Get() {
		case "models":
			return a.settingsModels()
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

// setGroup is a headed block of rows.
func setGroup(title string, rows ...core.Node) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return core.View{Style: core.Style{Gap: 6, Margin: core.Edges{Bottom: 14}}, Children: []core.Node{
			core.Text{Content: T(title), Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5, LetterSpacing: 0.6},
				StyleFunc: ui.Colored(colors.Faint)},
			core.View{StyleFunc: func() core.Style {
				return core.Style{Gap: 2, Padding: core.Symmetric(4, 10), CornerRadius: 9,
					BorderWidth: 1, BorderColor: colors.Now().Line, Background: colors.Surface()}
			}, Children: rows},
		}}
	})
}

// setRow is a row: what it is, why, and the control.
func setRow(label, help string, control core.Node) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		texts := []core.Node{
			core.Text{Content: T(label), Style: core.Style{FontSize: 12.5, LineHeight: 18}, StyleFunc: ui.Colored(colors.Text)},
		}
		if help != "" {
			texts = append(texts, core.Text{Content: T(help), MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Muted)})
		}
		children := []core.Node{core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: texts}}
		if control != nil {
			children = append(children, core.View{Style: core.Style{FlexShrink: 0}, Children: []core.Node{control}})
		}
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 12, MinHeight: core.Pt(38),
			Padding: core.Symmetric(3, 2)}, Children: children}
	})
}

// choice is one option of choiceChips.
type choice[T comparable] struct {
	Value T
	Label string
}

// choiceChips is a row of small options, one of them chosen.
func choiceChips[T comparable](options []choice[T], value func() T, onPick func(T)) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		var chips []core.Node
		for _, o := range options {
			opt := o
			on := func() bool { return value() == opt.Value }
			chips = append(chips, core.View{
				OnPress: func(core.PressEvent) { onPick(opt.Value) },
				Role:    core.RoleRadio, Label: opt.Label,
				StyleFunc: func() core.Style {
					st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Height: core.Pt(24), Padding: core.Symmetric(0, 9),
						CornerRadius: 12, BorderWidth: 1, BorderColor: colors.Border(), Hover: &core.Style{Background: colors.Hover()}}
					if on() {
						st.Background = colors.Pressed()
						st.BorderColor = colors.Text()
					}
					return st
				},
				Children: []core.Node{ui.Text(opt.Label, 11.5, ui.Regular, colors.Text)},
			})
		}
		return core.View{Style: core.Style{Direction: core.Row, Gap: 5}, Children: chips}
	})
}

// setDivider is the hairline between rows.
func setDivider() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		return core.View{Style: core.Style{Height: core.Pt(1), Margin: core.Edges{Left: 2}}, StyleFunc: ui.Filled(ui.ColorsOf(cx).Line)}
	})
}

// settingsGeneral says what a new session starts with.
func (a *app) settingsGeneral() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		var modelChips []core.Node
		addChip := func(label string, on func() bool, fn func()) core.Node {
			return core.View{
				OnPress: func(core.PressEvent) { fn() },
				Role:    core.RoleRadio, Label: label,
				StyleFunc: func() core.Style {
					st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Height: core.Pt(26), Padding: core.Symmetric(0, 9),
						CornerRadius: 13, BorderWidth: 1, BorderColor: colors.Border(), Hover: &core.Style{Background: colors.Hover()}}
					if on() {
						st.Background = colors.Pressed()
						st.BorderColor = colors.Text()
					}
					return st
				},
				Children: []core.Node{ui.Text(label, 11.5, ui.Regular, colors.Text)},
			}
		}
		modelChips = append(modelChips, addChip("跟随 pi 当前模型", func() bool { return a.defaultModel.ID == "" }, func() {
			a.defaultModel = modelChoice{}
			a.st.edit(func(c *config) { c.Model = modelChoice{} })
		}))
		for _, key := range a.favModels.Get() {
			provider, id, _ := strings.Cut(key, "/")
			label := id
			key := key
			modelChips = append(modelChips, addChip(label, func() bool { return a.defaultModel.Provider == provider && a.defaultModel.ID == id },
				func() {
					a.defaultModel = modelChoice{Provider: provider, ID: id}
					a.st.edit(func(c *config) { c.Model = a.defaultModel })
					_ = key
				}))
		}
		var levelChips []core.Node
		levelChips = append(levelChips, addChip("跟随会话", func() bool { return a.defaultThinking == "" }, func() {
			a.defaultThinking = ""
			a.st.edit(func(c *config) { c.Thinking = "" })
		}))
		for _, lv := range []string{"off", "low", "medium", "high", "max"} {
			lv := lv
			levelChips = append(levelChips, addChip(levelLabel(lv), func() bool { return a.defaultThinking == lv }, func() {
				a.defaultThinking = lv
				a.st.edit(func(c *config) { c.Thinking = lv })
			}))
		}
		return core.Scroll{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: 2}}, Children: []core.Node{
				setGroup("界面",
					setRow("语言", "界面文案；切换后立即生效，未翻译的条目保留中文。",
						choiceChips([]choice[string]{
							{langSystem, "跟随系统"}, {langZhCN, "简体中文"}, {langZhTW, "繁體中文"}, {langEnUS, "English"},
						}, func() string { return a.cfg.Language }, a.setLanguage)),
					setDivider(),
					setRow("内容宽度", "对话正文与输入框的最大宽度；窄一些更好读，宽一些能放下更多代码。",
						core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Width: core.Pt(230)}, Children: []core.Node{
							core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
								ui.Slider{Min: chatWidthMin, Max: chatWidthMax, Step: 20,
									Value:     func() float64 { return float64(a.contentWidth()) },
									Label:     T("对话内容宽度"),
									ValueText: func(v float64) string { return fmt.Sprintf("%.0f pt", v) },
									TestID:    "chat-width",
									OnChange:  func(v float64) { a.setChatWidth(int(v)) }},
							}},
							core.Text{ContentFunc: func() string { return fmt.Sprintf("%.0f pt", float64(a.contentWidth())) },
								Style:     core.Style{FontFamily: ui.Mono, FontSize: 10.5, MinWidth: core.Pt(44), TextAlign: core.TextAlignRight},
								StyleFunc: ui.Colored(colors.Muted)},
						}}),
				),
				setGroup("新会话默认模型", core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6, Padding: core.Symmetric(4, 2)},
					Children: modelChips}),
				setGroup("新会话默认思考等级", core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6, Padding: core.Symmetric(4, 2)},
					Children: levelChips}),
				setGroup("项目",
					setRow("项目排序", "侧栏项目按手动顺序、最近活动、创建时间或名称排列；置顶项目总在最前。",
						choiceChips([]choice[string]{
							{"", "手动"}, {"recent", "最近活动"}, {"created", "创建时间"}, {"title", "名称"},
						}, func() string { return a.cfg.ProjectSort }, a.setProjectSort)),
				),
				setGroup("会话列表",
					setRow("排序", "项目里的会话按最近活动或名称排列；置顶的总在最前。",
						choiceChips([]choice[string]{
							{"", "最近活动"}, {"name", "名称"},
						}, func() string { return a.cfg.SessionSort }, func(v string) {
							a.cfg.SessionSort = v
							a.st.edit(func(c *config) { c.SessionSort = v })
						})),
					setDivider(),
					setRow("扫描所有项目", "默认只读打开过的项目；打开后每个项目都会读一遍 pi 的会话，会话多时更慢。",
						ui.Switch{Checked: func() bool { return a.cfg.ScanAll }, Label: T("扫描所有项目"), OnChange: func(on bool) {
							a.cfg.ScanAll = on
							a.st.edit(func(c *config) { c.ScanAll = on })
							for _, ws := range a.workspaces.GetUntracked() {
								ws.piLoaded = false
							}
							a.reloadFrameworks()
						}}),
				),
				setGroup("侧栏",
					setRow("列出 pi 本地会话", "在项目下显示终端里 pi 用过的会话，点开即继续。",
						ui.Switch{Checked: func() bool { return a.cfg.ScanPi }, Label: T("列出 pi 本地会话"), OnChange: func(on bool) {
							a.cfg.ScanPi = on
							a.st.edit(func(c *config) { c.ScanPi = on })
							a.reloadFrameworks()
						}}),
					setDivider(),
					setRow("扫描所有项目", "连没有添加为项目的文件夹也读，会话多时会更慢。",
						ui.Switch{Checked: func() bool { return a.cfg.ScanAll }, Label: T("扫描所有项目"), OnChange: func(on bool) {
							a.cfg.ScanAll = on
							a.st.edit(func(c *config) { c.ScanAll = on })
							a.reloadFrameworks()
						}}),
				),
				setGroup("桌面",
					setRow("关闭窗口时留在托盘", "关掉窗口不退出应用，Agent 继续跑；从托盘图标恢复窗口。",
						ui.Switch{Checked: func() bool { return a.cfg.CloseToTray }, Label: T("关闭窗口时留在托盘"), TestID: "close-to-tray",
							OnChange: func(on bool) {
								a.cfg.CloseToTray = on
								a.st.edit(func(c *config) { c.CloseToTray = on })
							}}),
					setDivider(),
					setRow("一轮完成时通知", "用系统通知告诉你回答好了；运行中的会话也会显示在托盘菜单里。",
						ui.Switch{Checked: func() bool { return a.cfg.NotifyOnDone }, Label: T("一轮完成时通知"), TestID: "notify-done",
							OnChange: func(on bool) {
								a.cfg.NotifyOnDone = on
								a.st.edit(func(c *config) { c.NotifyOnDone = on })
							}}),
					setDivider(),
					setRow("只在窗口隐藏时通知", "窗口在前台时不再弹系统通知。",
						ui.Switch{Checked: func() bool { return a.cfg.NotifyOnlyHidden }, Label: T("只在窗口隐藏时通知"), TestID: "notify-hidden",
							OnChange: func(on bool) {
								a.cfg.NotifyOnlyHidden = on
								a.st.edit(func(c *config) { c.NotifyOnlyHidden = on })
							}}),
					setDivider(),
					setRow("桌面宠物", "用一个小窗口显示运行中/出错的会话数；点它回到主窗口。",
						ui.Switch{Checked: func() bool { return a.cfg.PetEnabled }, Label: T("桌面宠物"), TestID: "pet-enabled",
							OnChange: a.togglePet}),
					setDivider(),
					setRow("测试通知", "发一条系统通知，确认这台机器收得到。",
						ui.Button{Text: T("发一条"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
							a.notifyDesktop("pideck:test", "PiDeck Lite", "通知已开启，一轮完成时会这样提醒。", func(shown bool) {
								if !shown {
									a.toast(ui.ToastInfo, "系统没有接收通知", "请检查系统的通知权限，或安装后再试。")
								}
							})
						}}),
				),
			}},
		}}
	})
}

// settingsModels lists the providers, their credentials and favourites.
func (a *app) settingsModels() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		list := a.providers.Get()
		rank := map[string]int{}
		for i, id := range a.providerOrder() {
			rank[id] = i
		}
		sort.SliceStable(list, func(i, j int) bool { return rank[list[i].ID] < rank[list[j].ID] })
		var rows []core.Node
		if len(list) == 0 {
			rows = append(rows, setRow("没有读到供应商", "pi 的 models.json 里没有自定义供应商，或者还没探测完。", nil))
		}
		for i, p := range list {
			prov := p
			badge := func() core.Node {
				c := colors.Faint()
				switch prov.Auth {
				case "ready":
					c = colors.Up()
				case "not_ready":
					c = colors.Warn()
				case "invalid":
					c = colors.Danger()
				}
				return core.View{StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Padding: core.Symmetric(1, 7),
						CornerRadius: 10, Background: ui.Alpha(c, 0.10), BorderWidth: 1, BorderColor: ui.Alpha(c, 0.28)}
				}, Children: []core.Node{
					core.View{StyleFunc: func() core.Style {
						return core.Style{Width: core.Pt(5), Height: core.Pt(5), CornerRadius: 3, Background: c}
					}},
					ui.Text(authLabel(prov), 10.5, ui.Medium, func() core.Color { return c }),
				}}
			}
			row := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10, MinHeight: core.Pt(44),
				Padding: core.Symmetric(4, 2)}, Children: []core.Node{
				core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 2}, Children: []core.Node{
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
						core.Text{Content: prov.ID, Style: core.Style{FontFamily: ui.Mono, FontSize: 12.5, FontWeight: ui.Semibold},
							StyleFunc: ui.Colored(colors.Text)},
						ui.Text(fmt.Sprintf("%d 个模型", prov.Models), 10.5, ui.Regular, colors.Faint),
						ui.Text(prov.API, 10, ui.Regular, colors.Faint),
					}},
					core.Text{Content: shorten(prov.BaseURL, 70), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
					core.Show{When: func() bool { return prov.Reason != "" && prov.Auth != "ready" }, Then: func(*core.Scope) core.Node {
						return core.Text{Content: prov.Reason, Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5},
							StyleFunc: ui.Colored(colors.Danger)}
					}},
				}},
				badge(),
				hintOf(func() string { return T("配置 ") + prov.ID }, ui.IconButton{Icon: lucide.Settings2, Label: T("配置 ") + prov.ID, Size: 26, IconSize: 13,
					TestID: "provider-configure-" + prov.ID, OnPress: func() { a.openProviderDialog(prov.ID) }}),
				arrowButton(lucide.ArrowUpToLine, "置顶供应商", func() { a.pinProvider(prov.ID) }),
				arrowButton(lucide.ChevronUp, "上移供应商", func() { a.moveProvider(prov.ID, -1) }),
				arrowButton(lucide.ChevronDown, "下移供应商", func() { a.moveProvider(prov.ID, 1) }),
				core.View{OnPress: func(core.PressEvent) { a.copyText(loginCommand(prov), "登录命令") }, Role: core.RoleButton,
					Label: T("复制登录命令"),
					StyleFunc: func() core.Style {
						return core.Style{Height: core.Pt(24), Padding: core.Symmetric(0, 8), CornerRadius: 6,
							BorderWidth: 1, BorderColor: colors.Border(), AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
							Hover: &core.Style{Background: colors.Hover()}}
					},
					Children: []core.Node{ui.Text("复制登录命令", 10.5, ui.Regular, colors.Muted)}},
			}}
			rows = append(rows, row)
			if i < len(list)-1 {
				rows = append(rows, setDivider())
			}
		}
		var favRows []core.Node
		favKeys := a.favModels.Get()
		for i, key := range favKeys {
			key := key
			provider, id, _ := strings.Cut(key, "/")
			last := i == len(favKeys)-1
			favRows = append(favRows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(32),
				Padding: core.Symmetric(2, 2)}, Children: []core.Node{
				ui.Icon(lucide.Star, 11, colors.Text),
				ui.Text(provider, 10, ui.Regular, colors.Faint),
				core.Text{Content: id, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
					Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12}, StyleFunc: ui.Colored(colors.Text)},
				arrowButton(lucide.ChevronUp, "上移", func() { a.moveFavourite(key, -1) }),
				arrowButton(lucide.ChevronDown, "下移", func() {
					if !last {
						a.moveFavourite(key, 1)
					}
				}),
				core.View{OnPress: func(core.PressEvent) {
					a.toggleFavModel(modelInfo{Provider: provider, ID: id})
				}, Role: core.RoleButton, Label: T("取消收藏 ") + id,
					StyleFunc: func() core.Style {
						return core.Style{Width: core.Pt(22), Height: core.Pt(22), CornerRadius: 5, AlignItems: core.AlignCenter,
							JustifyContent: core.JustifyCenter, Hover: &core.Style{Background: colors.Hover()}}
					},
					Children: []core.Node{ui.Icon(lucide.X, 11, colors.Faint)}},
			}})
		}
		if len(favRows) == 0 {
			favRows = append(favRows, core.Text{Content: "在输入框的模型菜单里点星标收藏；收藏的模型排在最前，可在这里调顺序。",
				Style: core.Style{FontSize: 11, LineHeight: 16, Padding: core.Symmetric(4, 2)}, StyleFunc: ui.Colored(colors.Faint)})
		}
		return core.Scroll{TestID: "settings-content", Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: 2}}, Children: []core.Node{
				setGroup("常用模型", core.View{Style: core.Style{Gap: 1}, Children: favRows}),
				a.toolModelsGroup(),
				setGroup("供应商与认证", rows...),
				a.authGroup(),
				a.piSettingsGroup(),
				core.Text{Content: "凭据由 pi 管理（~/.pi/agent/auth.json）。在终端里执行登录命令后，点下方的「重新检测」。",
					Style: core.Style{FontSize: 11, LineHeight: 17}, StyleFunc: ui.Colored(colors.Faint)},
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6, Margin: core.Edges{Top: 2}}, Children: []core.Node{
					ui.Button{Text: T("编辑 models.json"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						OnPress: func() { a.openPiConfigFile("models.json") }},
					ui.Button{Text: T("编辑 settings.json"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						OnPress: func() { a.openPiConfigFile("settings.json") }},
					ui.Button{Text: T("编辑 auth.json"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						OnPress: func() { a.openPiConfigFile("auth.json") }},
					ui.Button{Text: T("重新检测"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: a.refreshProviders},
				}},
			}},
		}}
	})
}

// toolModelsGroup gives each AI tool its own provider and model.
func (a *app) toolModelsGroup() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		_ = a.toolRev.Get()
		colors := ui.ColorsOf(cx)
		configs := readProviderConfigs()
		tools := []struct{ ID, Name, Help string }{
			{"commit", "提交摘要", "按暂存改动生成一条提交说明，写进提交框。"},
			{"prompt", "提示词增强", "把输入框里的草稿改写得更清楚、更具体。"},
			{"predict", "输入预测", "在输入框里续写草稿的下一句。"},
		}
		var rows []core.Node
		for i, tool := range tools {
			tool := tool
			cfg := a.cfg.ToolModels[tool.ID]
			var providerOpts []ui.Option[string]
			for _, p := range configs {
				providerOpts = append(providerOpts, ui.Option[string]{Value: p.ID, Label: p.ID})
			}
			var modelOpts []ui.Option[string]
			for _, p := range configs {
				if p.ID != cfg.Provider {
					continue
				}
				for _, m := range p.Models {
					label := m.Name
					if label == "" {
						label = m.ID
					}
					modelOpts = append(modelOpts, ui.Option[string]{Value: m.ID, Label: label})
				}
			}
			control := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4}, Children: []core.Node{
				ui.Select[string]{Options: providerOpts, Value: func() string { return a.cfg.ToolModels[tool.ID].Provider },
					Placeholder: T("不启用"), OnClear: func() { a.setToolModel(tool.ID, "", "") },
					Label: T("供应商"), TestID: "tool-" + tool.ID + "-provider",
					Style: core.Style{Width: core.Pt(108)},
					OnChange: func(provider string) {
						model := ""
						for _, p := range configs {
							if p.ID == provider && len(p.Models) > 0 {
								model = p.Models[0].ID
								break
							}
						}
						a.setToolModel(tool.ID, provider, model)
					}},
				ui.Select[string]{Options: modelOpts, Value: func() string { return a.cfg.ToolModels[tool.ID].Model },
					Placeholder: T("模型"), Disabled: func() bool { return a.cfg.ToolModels[tool.ID].Provider == "" },
					Label: T("模型"), TestID: "tool-" + tool.ID + "-model",
					Style: core.Style{Width: core.Pt(126)},
					OnChange: func(model string) {
						a.setToolModel(tool.ID, a.cfg.ToolModels[tool.ID].Provider, model)
					}},
				hintOf(func() string { return T("清除") + " " + T(tool.Name) }, ui.IconButton{Icon: lucide.X, Label: T("清除") + " " + T(tool.Name), Size: 22, IconSize: 10,
					TestID: "tool-" + tool.ID + "-clear", Disabled: func() bool { return cfg.Provider == "" },
					OnPress: func() { a.setToolModel(tool.ID, "", "") }}),
			}}
			rows = append(rows, setRow(tool.Name, tool.Help, control))
			if i < len(tools)-1 {
				rows = append(rows, setDivider())
			}
		}
		if len(configs) == 0 {
			rows = append(rows, core.Text{Content: T("还没有读到供应商；先在下面配置一个，或检查 pi 的 models.json。"),
				Style: core.Style{FontSize: 11, LineHeight: 16, Padding: core.Symmetric(4, 2)}, StyleFunc: ui.Colored(colors.Faint)})
		}
		return setGroup("工具模型", rows...)
	})
}

// settingsKeys edits each command's shortcut. A field commits on Enter;
// an empty field unbinds, and "默认" puts the default back.
func (a *app) settingsKeys() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		var rows []core.Node
		cmds := a.keybindingCommands()
		for i, c := range cmds {
			cmd := c
			desc := T(cmd.Group)
			if src := a.bindingSource(cmd.ID); src != "" && src != "默认" {
				desc += " · " + src
			}
			field := core.Input{
				Value:       func() string { return a.effectiveKey(cmd.ID) },
				Placeholder: T("如 mod+shift+r"),
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
					FontFamily: ui.Mono, Color: colors.Text(), Background: colors.Field(),
					BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 6},
			}
			reset := ui.Button{Text: T("默认"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
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
		return core.Scroll{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: 2}, Gap: 6}, Children: []core.Node{
				setGroup("命令", rows...),
				core.Text{Content: "写法：mod（Mac 的 Command / 其他平台的 Ctrl）、ctrl、alt、shift、meta 加键名，例如 mod+shift+g、ctrl+tab、f5。回车保存，留空取消绑定。",
					Style: core.Style{FontSize: 11, LineHeight: 17}, StyleFunc: ui.Colored(colors.Faint)},
				core.Show{When: func() bool { return len(conflicts) > 0 }, Then: func(*core.Scope) core.Node {
					return setGroup("冲突", conflicts...)
				}},
				core.View{Style: core.Style{Direction: core.Row, Gap: 8, Margin: core.Edges{Top: 2}}, Children: []core.Node{
					ui.Button{Text: T("全部恢复默认"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: a.resetKeybindings},
				}},
			}},
		}}
	})
}

// settingsLook picks the palette.
func (a *app) settingsLook() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		_ = a.bgImage.Get()
		var rows []core.Node
		fontControl := func(value func() string, set func(string), label, testID, placeholder string) core.Node {
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				core.Input{Value: value, OnChange: set, OnSubmit: func(string) { a.applyFonts() },
					Placeholder: placeholder, Label: label, TestID: testID,
					Style: core.Style{Width: core.Pt(160), Height: core.Pt(28), Padding: core.Symmetric(0, 8), FontSize: 11,
						Color: colors.Text(), Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 6}},
				ui.Button{Text: T("应用"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: a.applyFonts},
			}}
		}
		visible := make([]themeSpec, 0, len(a.themes.Get()))
		for _, spec := range a.themes.Get() {
			// 纸白/炭黑 只是默认配色的明暗两半；不选它们时收起来，避免和跟随系统重复。
			if (spec.ID == "light" || spec.ID == "dark") && a.theme.Get() != spec.ID {
				continue
			}
			visible = append(visible, spec)
		}
		for i, spec := range visible {
			s := spec
			on := func() bool { return a.theme.Get() == s.ID }
			var note string
			switch {
			case s.Error != "":
				note = "读取失败"
			case s.Author != "":
				note = s.Author
			}
			rows = append(rows, core.View{
				OnPress: func(core.PressEvent) { a.setTheme(s.ID) },
				Role:    core.RoleRadio, Label: s.Name, TestID: "theme-" + s.ID,
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10, Height: core.Pt(34),
						Padding: core.Symmetric(2, 2), CornerRadius: 6, Hover: &core.Style{Background: colors.Hover()}}
				},
				Children: []core.Node{
					themePreview(s),
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
						ui.Text(s.Name, 12.5, ui.Regular, colors.Text),
						core.Show{When: func() bool { return note != "" }, Then: func(*core.Scope) core.Node {
							return core.Text{Content: note, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
								Style: core.Style{FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)}
						}},
					}},
					core.Show{When: func() bool { return s.Appearance == "light" || s.Appearance == "dark" },
						Then: func(*core.Scope) core.Node {
							label := "仅浅色"
							if s.Appearance == "dark" {
								label = "仅深色"
							}
							return ui.Text(label, 9.5, ui.Regular, colors.Faint)
						}},
					core.Show{When: func() bool { return !s.Builtin && s.Source != "" }, Then: func(*core.Scope) core.Node {
						return core.View{OnPress: func(core.PressEvent) { a.deleteTheme(s) }, Role: core.RoleButton,
							Label: T("删除主题") + " " + s.Name, TestID: "theme-delete-" + strings.ReplaceAll(s.ID, ":", "-"),
							StyleFunc: func() core.Style {
								return core.Style{Width: core.Pt(22), Height: core.Pt(22), CornerRadius: 5, AlignItems: core.AlignCenter,
									JustifyContent: core.JustifyCenter, Hover: &core.Style{Background: colors.Pressed()}}
							}, Children: []core.Node{ui.Icon(lucide.Trash, 11, colors.Faint)}}
					}},
					core.Show{When: on, Then: func(*core.Scope) core.Node { return ui.Icon(lucide.Check, 13, colors.Text) }},
					core.Show{When: func() bool { return !s.Builtin }, Then: func(*core.Scope) core.Node {
						return ui.Text("用户主题", 9.5, ui.Regular, colors.Faint)
					}},
				},
			})
			if i < len(visible)-1 {
				rows = append(rows, setDivider())
			}
		}
		return core.Scroll{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: 2}, Gap: 4}, Children: []core.Node{
				setGroup("配色", rows...),
				a.backgroundGroup(colors),
				setRow("主题文件", "放在数据目录的 themes 里：JSON 或 YAML，写角色色、tokens、字体与圆角；也读 shadcn/ui 主题文件。",
					ui.Button{Text: T("打开目录"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() {
						a.openThemesDir()
					}}),
				setDivider(),
				setRow("导出当前主题", "把当前配色、tokens、字体与圆角写成一个主题文件，可分享或继续改。",
					ui.Button{Text: T("导出"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "theme-export",
						OnPress: a.exportTheme}),
				setDivider(),
				setRow("终端字号", "底部终端面板的文字大小，8–20 pt；改完立即重绘。",
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Width: core.Pt(200)}, Children: []core.Node{
						core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
							ui.Slider{Min: 8, Max: 20, Step: 1, Value: func() float64 { return a.termFont.Get() },
								Label: T("终端字号"), ValueText: func(v float64) string { return fmt.Sprintf("%.0f pt", v) },
								TestID: "term-font", OnChange: a.setTerminalFont},
						}},
						core.Text{ContentFunc: func() string { return fmt.Sprintf("%.0f pt", a.termFont.Get()) },
							Style:     core.Style{FontFamily: ui.Mono, FontSize: 10.5, MinWidth: core.Pt(38), TextAlign: core.TextAlignRight},
							StyleFunc: ui.Colored(colors.Muted)},
					}}),
				setRow("编辑器字号", "中间编辑器的文字大小，11–20 pt；改完立即重绘。",
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Width: core.Pt(200)}, Children: []core.Node{
						core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
							ui.Slider{Min: 11, Max: 20, Step: 1, Value: func() float64 { return a.editorFont.Get() },
								Label: T("编辑器字号"), ValueText: func(v float64) string { return fmt.Sprintf("%.0f pt", v) },
								TestID: "editor-font", OnChange: a.setEditorFont},
						}},
						core.Text{ContentFunc: func() string { return fmt.Sprintf("%.0f pt", a.editorFont.Get()) },
							Style:     core.Style{FontFamily: ui.Mono, FontSize: 10.5, MinWidth: core.Pt(38), TextAlign: core.TextAlignRight},
							StyleFunc: ui.Colored(colors.Muted)},
					}}),
				setDivider(),
				setRow("界面字体", "系统已安装的字体名，如 Georgia；留空跟随主题。回车或点「应用」生效。",
					fontControl(func() string { return a.cfg.UIFont }, func(v string) {
						a.cfg.UIFont = strings.TrimSpace(v)
						if a.st != nil {
							a.st.edit(func(c *config) { c.UIFont = a.cfg.UIFont })
						}
					}, T("界面字体"), "ui-font", T("留空跟随主题"))),
				setDivider(),
				setRow("等宽字体", "编辑器使用的等宽字体名，如 JetBrains Mono；留空用系统等宽字体。",
					fontControl(func() string { return a.cfg.MonoFont }, func(v string) {
						a.cfg.MonoFont = strings.TrimSpace(v)
						if a.st != nil {
							a.st.edit(func(c *config) { c.MonoFont = a.cfg.MonoFont })
						}
					}, T("等宽字体"), "mono-font", T("留空用系统等宽字体"))),
				core.Text{Content: "角色：background surface border text textMuted accent danger warning success selection focus scrollbar inset raised field line faint code info track knob。",
					Style: core.Style{FontSize: 11, LineHeight: 17}, StyleFunc: ui.Colored(colors.Faint)},
			}},
		}}
	})
}

// backgroundGroup edits the picture behind the app and how much of it
// shows.
func (a *app) backgroundGroup(colors ui.Colors) core.Node {
	path := a.cfg.BackgroundImage
	var preview core.Node
	if path != "" {
		preview = core.Image{Source: core.ImageSource{URI: fileURL(path)}, ResizeMode: core.Cover,
			Style: core.Style{Width: core.Pt(80), Height: core.Pt(46), CornerRadius: 6, BorderWidth: 1, BorderColor: colors.Border()}}
	} else {
		preview = core.View{Style: core.Style{Width: core.Pt(80), Height: core.Pt(46), CornerRadius: 6,
			BorderWidth: 1, BorderColor: colors.Border(), AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter},
			Children: []core.Node{ui.Text("—", 12, ui.Regular, colors.Faint)}}
	}
	choose := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
		preview,
		ui.Button{Text: T("选择图片"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "bg-image-choose",
			OnPress: func() {
				a.cx.PickFiles(core.PickFilesOptions{Types: []string{".png", ".jpg", ".jpeg", ".webp", ".gif"}, Limit: 1},
					func(files []core.File, err error) {
						if err != nil {
							a.toast(ui.ToastError, T("选择图片失败"), err.Error())
							return
						}
						if len(files) > 0 {
							a.setBackgroundImage(files[0].Path)
						}
					})
			}},
		core.Show{When: func() bool { return a.cfg.BackgroundImage != "" }, Then: func(*core.Scope) core.Node {
			return ui.Button{Text: T("清除"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "bg-image-clear",
				OnPress: func() { a.setBackgroundImage("") }}
		}},
	}}
	opacity := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Width: core.Pt(200)}, Children: []core.Node{
		core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
			ui.Slider{Min: 0, Max: 100, Step: 1, Value: func() float64 { return a.backgroundOpacity() * 100 },
				Label: T("背景透明度"), ValueText: func(v float64) string { return fmt.Sprintf("%.0f%%", v) },
				TestID: "bg-opacity", OnChange: func(v float64) {
					a.setBackgroundOpacity(v / 100)
				}},
		}},
		core.Dynamic(func(*core.Scope) core.Node {
			return core.Text{Content: fmt.Sprintf("%.0f%%", a.bgOpacity.Get()*100),
				Style:     core.Style{FontFamily: ui.Mono, FontSize: 10.5, MinWidth: core.Pt(38), TextAlign: core.TextAlignRight},
				StyleFunc: ui.Colored(colors.Muted)}
		}),
	}}
	return setGroup("背景",
		setRow("背景图片", "从本机选一张图片铺满窗口，只保存路径。", choose),
		setDivider(),
		setRow("背景透明度", "0% 完全遮住图片，100% 完全显示；面板会一起变透明。", opacity),
	)
}

// settingsEnv shows what the probe found on every machine.
func (a *app) settingsEnv() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		info := a.env.Get()
		piOK := info.PiPath != "" && info.PiError == ""
		var rows []core.Node
		rows = append(rows,
			setRow("pi 可执行文件", func() string {
				if !piOK {
					return "没找到：" + firstLine(info.PiError, 80)
				}
				return info.PiPath
			}(), ui.Text(piVersionLine(info), 10.5, ui.Regular, colors.Faint)),
			setDivider(),
			setRow("pi 会话目录", info.SessionsDir, ui.Button{Text: T("打开"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
				if info.SessionsDir != "" {
					a.cx.OpenURL(fileURL(info.SessionsDir), nil)
				}
			}}),
			setDivider(),
			setRow("pi 配置目录", piConfigDir(), ui.Button{Text: T("打开"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
				if dir := piConfigDir(); dir != "" {
					a.cx.OpenURL(fileURL(dir), nil)
				}
			}}),
			setDivider(),
			setRow("外部编辑器", detectedEditorsText(), core.Input{
				Value: func() string { return a.cfg.EditorCommand }, Placeholder: T("code / cursor / 自定义命令"),
				Label: T("外部编辑器命令"), TestID: "editor-command",
				OnChange: func(v string) {
					a.cfg.EditorCommand = v
					a.st.edit(func(c *config) { c.EditorCommand = v })
				},
				Style: core.Style{Width: core.Pt(170), Height: core.Pt(28), Padding: core.Symmetric(0, 8), FontSize: 11,
					FontFamily: ui.Mono, Color: colors.Text(), Background: colors.Field(),
					BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 6},
			}),
		)
		proxyField := func(value func() string, set func(string), placeholder, label, testID string) core.Node {
			return core.Input{Value: value, Placeholder: placeholder, Label: label, TestID: testID,
				OnChange: set,
				Style: core.Style{Width: core.Pt(190), Height: core.Pt(28), Padding: core.Symmetric(0, 8), FontSize: 11,
					FontFamily: ui.Mono, Color: colors.Text(), Background: colors.Field(),
					BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 6}}
		}
		proxyRows := []core.Node{
			setRow("应用请求代理", "供应商测试/余额、飞书与 Git 的网络请求；留空直连。", proxyField(
				func() string { return a.cfg.ProxyApp },
				func(v string) {
					a.cfg.ProxyApp = v
					a.st.edit(func(c *config) { c.ProxyApp = v })
					a.applyProxy()
				}, "http://127.0.0.1:7890", "应用请求代理", "proxy-app")),
			setDivider(),
			setRow("Agent 代理", "启动 pi 与 ACP 时写入 HTTP(S)_PROXY；重启 Agent 后生效。", proxyField(
				func() string { return a.cfg.ProxyAgent },
				func(v string) {
					a.cfg.ProxyAgent = v
					a.st.edit(func(c *config) { c.ProxyAgent = v })
					a.applyProxy()
				}, "http://127.0.0.1:7890", "Agent 代理", "proxy-agent")),
			setDivider(),
			setRow("直连名单", "NO_PROXY，逗号分隔域名或网段；两侧共用。", proxyField(
				func() string { return a.cfg.ProxyBypass },
				func(v string) {
					a.cfg.ProxyBypass = v
					a.st.edit(func(c *config) { c.ProxyBypass = v })
					a.applyProxy()
				}, "localhost,127.0.0.1,.local", "直连名单", "proxy-bypass")),
		}
		var targets []core.Node
		if info.TargetsProbing {
			targets = append(targets, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Symmetric(2, 0)}, Children: []core.Node{
				ui.Spinner{Size: 12}, ui.Text("正在检测 WSL 与 SSH…", 11.5, ui.Regular, colors.Muted)}})
		}
		for _, d := range info.WSL {
			ok := d.PiPath != ""
			status := d.PiPath
			if !ok {
				status = "未找到 pi：" + firstLine(d.Error, 60)
			}
			targets = append(targets, targetStatusRow("WSL", d.Name, status, ok))
		}
		for _, h := range info.SSH {
			ok := h.PiPath != ""
			status := h.PiPath
			if !ok {
				status = "连不上或没有 pi：" + firstLine(h.Error, 60)
			}
			targets = append(targets, targetStatusRow("SSH", h.Name, status, ok))
		}
		if len(info.WSL) == 0 && len(info.SSH) == 0 && !info.TargetsProbing {
			targets = append(targets, core.Text{Content: "没有读到 WSL 发行版或 SSH Host。",
				Style: core.Style{FontSize: 11.5}, StyleFunc: ui.Colored(colors.Faint)})
		}
		return core.Scroll{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: 2}, Gap: 2}, Children: []core.Node{
				setGroup("本机", rows...),
				setGroup("网络代理", proxyRows...),
				core.Text{Content: "应用代理只影响应用自己发出的请求；Agent 代理在启动进程时注入环境变量。",
					Style: core.Style{FontSize: 11, LineHeight: 17}, StyleFunc: ui.Colored(colors.Faint)},
				setGroup("其它机器", targets...),
				core.View{Style: core.Style{Direction: core.Row, Gap: 8, Margin: core.Edges{Top: 4}}, Children: []core.Node{
					ui.Button{Text: T("添加 WSL 工作区"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() {
						a.settings.Set(false)
						a.openTargetDialog(targetWSL)
					}},
					ui.Button{Text: T("添加 SSH 工作区"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() {
						a.settings.Set(false)
						a.openTargetDialog(targetSSH)
					}},
				}},
			}},
		}}
	})
}

// targetStatusRow is one WSL distribution or SSH host and whether pi
// answers there.
func targetStatusRow(kind, name, status string, ok bool) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		icon := lucide.Globe
		if kind == "WSL" {
			icon = lucide.Monitor
		}
		ink := colors.Faint()
		if !ok {
			ink = colors.Danger()
		}
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(30),
			Padding: core.Symmetric(2, 2)}, Children: []core.Node{
			ui.IconOf(icon, 13, colors.Muted),
			ui.Text(kind, 9.5, ui.Medium, colors.Faint),
			core.Text{Content: name, Style: core.Style{FlexGrow: 0, FontSize: 12}, StyleFunc: ui.Colored(colors.Text)},
			core.View{Style: core.Style{FlexGrow: 1}},
			core.Text{Content: shorten(status, 52), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style:     core.Style{FontFamily: ui.Mono, FontSize: 10.5},
				StyleFunc: ui.Colored(func() core.Color { return ink })},
		}}
	})
}

// arrowButton is a small up/down control for ordering a list.
func arrowButton(icon func() *core.SVG, label string, fn func()) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return core.View{OnPress: func(core.PressEvent) { fn() }, Role: core.RoleButton, Label: label,
			StyleFunc: func() core.Style {
				return core.Style{Width: core.Pt(22), Height: core.Pt(22), CornerRadius: 5, AlignItems: core.AlignCenter,
					JustifyContent: core.JustifyCenter, Hover: &core.Style{Background: colors.Hover()}}
			},
			Children: []core.Node{ui.Icon(icon, 12, colors.Muted)}}
	})
}

// piVersionLine is the pi version, or that there is none.
func piVersionLine(info envInfo) string {
	if info.PiVersion != "" {
		return "pi " + info.PiVersion
	}
	if info.PiError != "" {
		return "找不到 pi"
	}
	return "检测中…"
}

// settingsAddons lists the plugins, what each adds, and whether it runs.
func (a *app) settingsAddons() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		list := a.plugins.Get()
		var rows []core.Node
		if len(list) == 0 {
			rows = append(rows, setRow("还没有插件",
				"在数据目录的 plugins 里放一个 plugin.json，就能给命令面板加命令、给外观加主题。", nil))
		}
		for i, p := range list {
			plug := p
			desc := plug.Description
			if plug.Error != "" {
				desc = "读取失败：" + firstLine(plug.Error, 100)
			}
			title := plug.Name
			if plug.Version != "" {
				title += "  " + plug.Version
			}
			var control core.Node
			if plug.Error == "" {
				control = ui.Switch{
					Checked: func() bool { return !plug.Disabled },
					Label:   T("启用 ") + plug.Name,
					Size:    ui.SizeSmall,
					TestID:  "plugin-toggle-" + plug.ID,
					OnChange: func(on bool) {
						a.setPluginEnabled(plug.ID, on)
					},
				}
			} else {
				control = ui.Text("无法读取", 10.5, ui.Regular, colors.Danger)
			}
			if plug.Path != "" {
				dir, path := plug.Dir, plug.Path
				open := hintOf(func() string { return T("查看插件清单") }, ui.IconButton{Icon: lucide.FileText, Label: T("查看插件清单"), Size: 24, IconSize: 12,
					TestID: "plugin-open-" + plug.ID, OnPress: func() {
						a.settings.Set(false)
						a.openEditorFile(dir, path)
					}})
				control = core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4},
					Children: []core.Node{control, open}}
			}
			rows = append(rows, setRow(title, desc, control))
			var lines []core.Node
			meta := pluginSummary(plug)
			if plug.Author != "" {
				meta += " · " + plug.Author
			}
			lines = append(lines, core.Text{Content: meta, Style: core.Style{FontSize: 10.5},
				StyleFunc: ui.Colored(colors.Faint)})
			for _, w := range plug.Warnings {
				lines = append(lines, core.Text{Content: T("注意：%s", w), Style: core.Style{FontSize: 10.5},
					StyleFunc: ui.Colored(colors.Warn)})
			}
			for _, c := range plug.Commands {
				label := "· " + c.Title
				if c.Group != "" {
					label += "  · " + c.Group
				}
				lines = append(lines, core.Text{Content: label, Style: core.Style{FontSize: 10.5},
					StyleFunc: ui.Colored(colors.Muted)})
			}
			for _, th := range plug.ThemeSpecs {
				lines = append(lines, core.Text{Content: T("· 主题 %s", th.Name), Style: core.Style{FontSize: 10.5},
					StyleFunc: ui.Colored(colors.Muted)})
			}
			for _, kb := range plug.Contributes.Keybindings {
				lines = append(lines, core.Text{Content: T("· 键位 %s → %s", kb.Key, kb.Command),
					Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)})
			}
			var hooks []string
			for name := range plug.Contributes.Hooks {
				hooks = append(hooks, name)
			}
			sort.Strings(hooks)
			for _, name := range hooks {
				lines = append(lines, core.Text{Content: fmt.Sprintf("· 事件 %s → %d 个动作", name, len(plug.Contributes.Hooks[name])),
					Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)})
			}
			if len(lines) > 0 {
				rows = append(rows, core.View{Style: core.Style{Padding: core.Edges{Left: 4, Bottom: 4}, Gap: 1}, Children: lines})
			}
			if len(plug.Contributes.Settings) > 0 {
				var settingRows []core.Node
				for _, st := range plug.Contributes.Settings {
					setting := st
					settingRows = append(settingRows, setRow(setting.Label, setting.Description,
						a.pluginSettingControl(plug, setting)))
				}
				rows = append(rows, core.View{Style: core.Style{Padding: core.Edges{Left: 4, Bottom: 6}, Gap: 3}, Children: []core.Node{
					core.Text{Content: "设置", Style: core.Style{FontFamily: ui.Mono, FontSize: 9, LetterSpacing: 0.5},
						StyleFunc: ui.Colored(colors.Faint)},
					core.View{StyleFunc: func() core.Style {
						return core.Style{Gap: 1, Padding: core.Symmetric(3, 8), CornerRadius: 7,
							Background: colors.Inset(), BorderWidth: 1, BorderColor: colors.Line()}
					}, Children: settingRows},
				}})
			}
			if i < len(list)-1 {
				rows = append(rows, setDivider())
			}
		}
		return core.Scroll{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: 2}, Gap: 4}, Children: []core.Node{
				setGroup("插件", rows...),
				core.Text{Content: "插件只声明命令与主题，不运行代码：命令的动作是填入提示词、执行内置命令、打开链接或切换主题。",
					Style: core.Style{FontSize: 11, LineHeight: 17}, StyleFunc: ui.Colored(colors.Faint)},
				core.View{Style: core.Style{Direction: core.Row, Gap: 8, Margin: core.Edges{Top: 4}}, Children: []core.Node{
					ui.Button{Text: T("新建插件…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "plugin-new",
						OnPress: a.openPluginNew},
					ui.Button{Text: T("插件市场…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "plugin-market-open",
						OnPress: a.openPluginMarket},
					ui.Button{Text: T("打开插件目录"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() {
						a.openPluginsDir()
					}},
					ui.Button{Text: T("重新加载"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: a.reloadAddons},
				}},
			}},
		}}
	})
}

// pluginSettingControl is the control for one plugin setting: a switch,
// a row of choices, or a field that saves as it changes.
func (a *app) pluginSettingControl(p plugin, s pluginSetting) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		testID := "plugin-setting-" + p.ID + "-" + s.Key
		switch s.Type {
		case "bool":
			return ui.Switch{Checked: func() bool { return a.pluginSetting(p.ID, s.Key) == "true" },
				Label: s.Label, Size: ui.SizeSmall, TestID: testID,
				OnChange: func(on bool) { a.setPluginSetting(p.ID, s.Key, settingText(on)) }}
		case "select":
			var radios []core.Node
			for _, opt := range s.Options {
				value := opt
				radios = append(radios, ui.Radio{Text: opt, TestID: testID + "-" + value,
					Checked:  func() bool { return a.pluginSetting(p.ID, s.Key) == value },
					OnChange: func(bool) { a.setPluginSetting(p.ID, s.Key, value) }})
			}
			return ui.RadioGroup{Horizontal: true, Children: radios, Label: s.Label}
		default:
			return core.Input{
				Value: func() string { return a.pluginSetting(p.ID, s.Key) }, Label: s.Label, TestID: testID,
				Placeholder: settingText(s.Default),
				OnChange:    func(v string) { a.setPluginSetting(p.ID, s.Key, v) },
				Style: core.Style{Height: core.Pt(26), Padding: core.Symmetric(0, 8), CornerRadius: 6, FontSize: 11,
					FontFamily: ui.Mono, Color: colors.Text(), Background: colors.Field(),
					BorderWidth: 1, BorderColor: colors.FieldBorder(), MinWidth: core.Pt(150)},
			}
		}
	})
}

// settingsIntegrations configures the Feishu group bot.
func (a *app) settingsIntegrations() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		field := func(value func() string, set func(string), placeholder, label, testID string, masked bool) core.Node {
			return core.Input{Value: value, OnChange: set, Placeholder: placeholder, Label: label, Masked: masked,
				TestID: testID,
				Style: core.Style{Height: core.Pt(30), Padding: core.Symmetric(0, 8), CornerRadius: 6, FontSize: 11,
					FontFamily: ui.Mono, Color: colors.Text(), Background: colors.Field(),
					BorderWidth: 1, BorderColor: colors.FieldBorder()}}
		}
		setCfg := func(fn func(*config)) {
			fn(&a.cfg)
			a.st.edit(fn)
		}
		return core.Scroll{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: 2}, Gap: 4}, Children: []core.Node{
				setGroup("飞书",
					setRow("飞书机器人", "一轮结束时，把会话标题、状态和一句摘要发到群里的自定义机器人。",
						ui.Switch{Checked: func() bool { return a.cfg.FeishuEnabled }, Label: T("飞书机器人"), TestID: "feishu-enabled",
							OnChange: func(on bool) { setCfg(func(c *config) { c.FeishuEnabled = on }) }}),
					setDivider(),
					setRow("Webhook 地址", "飞书群 → 设置 → 群机器人 → 自定义机器人，复制它的 Webhook 地址。",
						field(func() string { return a.cfg.FeishuWebhook }, func(v string) {
							setCfg(func(c *config) { c.FeishuWebhook = v })
						}, "https://open.feishu.cn/open-apis/bot/v2/hook/…", "Webhook 地址", "feishu-webhook", false)),
					setDivider(),
					setRow("签名密钥", "机器人开启签名校验时填写；不校验就留空。",
						field(func() string { return a.cfg.FeishuSecret }, func(v string) {
							setCfg(func(c *config) { c.FeishuSecret = v })
						}, "可留空", "签名密钥", "feishu-secret", true)),
					setDivider(),
					setRow("接收群消息", "飞书开放平台的「事件订阅」地址填 http://<本机地址>:<远程端口>/api/feishu；先在「远程」里开启服务。",
						ui.Switch{Checked: func() bool { return a.cfg.FeishuInbound }, Label: T("接收群消息"), TestID: "feishu-inbound",
							OnChange: func(on bool) { setCfg(func(c *config) { c.FeishuInbound = on }) }}),
					setDivider(),
					setRow("验证 Token", "飞书应用「事件订阅」里的 Verification Token；不填就不接收。",
						field(func() string { return a.cfg.FeishuVerifyToken }, func(v string) {
							setCfg(func(c *config) { c.FeishuVerifyToken = v })
						}, "Verification Token", "验证 Token", "feishu-verify-token", true)),
					setDivider(),
					setRow("把回答发回群", "收到群消息后，把这一轮的回答也发到群里（用上面的 Webhook）。",
						ui.Switch{Checked: func() bool { return a.cfg.FeishuReply }, Label: T("把回答发回群"), TestID: "feishu-reply",
							OnChange: func(on bool) { setCfg(func(c *config) { c.FeishuReply = on }) }}),
					setDivider(),
					setRow("测试", "发一条测试消息，确认地址与签名都对。",
						ui.Button{Text: T("发一条"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "feishu-test",
							OnPress: a.testFeishu}),
				),
				setGroup("ACP 预设",
					setRow("自定义预设", "内置 Claude / Gemini / Codex；也可以在这里加任何 ACP 命令，写进数据目录的 acp/presets.json。",
						ui.Button{Text: T("管理预设…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "acp-manage-open",
							OnPress: func() { a.openACPPresetManager() }}),
				),
				core.Text{Content: "默认只发会话标题、状态与一句摘要；开启「把回答发回群」后，回答最多发 1500 字。", Style: core.Style{FontSize: 11, LineHeight: 17},
					StyleFunc: ui.Colored(colors.Faint)},
			}},
		}}
	})
}

// settingsDiagnostics shows what is running and what went wrong.
func (a *app) settingsDiagnostics() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		_ = a.clock.Get()
		var mem runtime.MemStats
		runtime.ReadMemStats(&mem)
		uptime := "—"
		if !a.startedAt.IsZero() {
			uptime = duration(time.Since(a.startedAt))
		}
		procs := a.processList()
		var procRows []core.Node
		for i, p := range procs {
			proc := p
			detail := proc.Detail
			if proc.PID > 0 {
				detail += " · pid " + fmt.Sprint(proc.PID)
			}
			if proc.Stderr != "" {
				detail += " · " + proc.Stderr
			}
			procRows = append(procRows, setRow(proc.Kind+" · "+proc.Name, detail,
				ui.Text(proc.State, 10.5, ui.Regular, colors.Faint)))
			if i < len(procs)-1 {
				procRows = append(procRows, setDivider())
			}
		}
		if len(procRows) == 0 {
			procRows = append(procRows, setRow("没有运行中的进程", "打开会话或终端后会出现在这里。", nil))
		}
		events := a.diagSnapshot()
		start := max(0, len(events)-60)
		var logRows []core.Node
		for _, ev := range events[start:] {
			color := colors.Muted
			if ev.Level == "error" {
				color = colors.Danger
			} else if ev.Level == "warn" {
				color = colors.Warn
			}
			logRows = append(logRows, core.Text{Content: ev.Time.Format("15:04:05") + "  " + ev.Text, MaxLines: 2,
				Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5, LineHeight: 14}, StyleFunc: ui.Colored(color)})
		}
		if len(logRows) == 0 {
			logRows = append(logRows, core.Text{Content: "还没有日志。", Style: core.Style{FontSize: 10.5},
				StyleFunc: ui.Colored(colors.Faint)})
		}
		var crashRows []core.Node
		if path, at, ok := latestCrash(a.dataDir); ok {
			crashRows = append(crashRows,
				setRow("最近崩溃", at.Format("2006-01-02 15:04:05")+" · "+filepath.Base(path),
					core.View{Style: core.Style{Direction: core.Row, Gap: 6}, Children: []core.Node{
						ui.Button{Text: T("查看"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "crash-view",
							OnPress: func() { a.openEditorFile(filepath.Dir(path), path) }},
						ui.Button{Text: T("打开目录"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "crash-dir",
							OnPress: func() { a.openResourcesDir(crashDir(a.dataDir)) }},
					}}),
				setDivider(),
				setRow("崩溃日志", fmt.Sprintf("共 %d 个文件；panic 时自动写入数据目录的 crashes/。", crashCount(a.dataDir)), nil),
			)
		} else {
			crashRows = append(crashRows, setRow("崩溃日志", "还没有崩溃记录；panic 时自动写到数据目录的 crashes/。", nil))
		}
		return core.Scroll{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: 2}, Gap: 4}, Children: []core.Node{
				setGroup("运行",
					setRow("版本", fmt.Sprintf("%s · %s/%s · Go %s", appVersion, runtime.GOOS, runtime.GOARCH, runtime.Version()), nil),
					setDivider(),
					setRow("内存与协程", T("堆 %.1f MB · %d 个 goroutine · 已运行 %s",
						float64(mem.HeapAlloc)/(1<<20), runtime.NumGoroutine(), uptime), nil),
				),
				setGroup("崩溃", crashRows...),
				setGroup("进程", procRows...),
				setGroup("最近日志", core.View{Style: core.Style{Gap: 2, Padding: core.Symmetric(4, 2)}, Children: logRows}),
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6, Margin: core.Edges{Top: 2}}, Children: []core.Node{
					ui.Button{Text: T("复制诊断信息"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "diag-copy",
						OnPress: func() { a.copyText(a.diagnosticText(), "诊断信息") }},
					ui.Button{Text: T("导出诊断包"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "diag-bundle",
						OnPress: a.exportDiagnostics},
					ui.Button{Text: T("打开日志目录"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
						if dir := a.diagDir(); dir != "" {
							a.cx.OpenURL(fileURL(dir), nil)
						}
					}},
					ui.Button{Text: T("清空内存日志"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
						a.clearDiag()
						a.toast(ui.ToastInfo, "内存日志已清空", "日志文件仍在数据目录的 logs 下。")
					}},
				}},
			}},
		}}
	})
}

// detectedEditorsText names the editors found on PATH.
func detectedEditorsText() string {
	list := detectEditors()
	if len(list) == 0 {
		return "没有在 PATH 里找到常见编辑器；可以填一个命令。"
	}
	names := make([]string, 0, len(list))
	for _, e := range list {
		names = append(names, e.Name)
	}
	return "已找到：" + strings.Join(names, "、")
}

// settingsData shows the folders the app writes.
func (a *app) settingsData() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		dir, sessions := "", ""
		if a.st != nil {
			dir, sessions = a.st.dir, a.st.sessions
		}
		count := 0
		if a.st != nil {
			count = a.st.countSessions()
		}
		piCount := 0
		for _, ws := range a.workspaces.Get() {
			piCount += len(ws.Pi.Get())
		}
		return core.Scroll{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: 2}, Gap: 2}, Children: []core.Node{
				setGroup("位置",
					setRow("数据目录", dir, ui.Button{Text: T("打开"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
						if dir != "" {
							a.cx.OpenURL(fileURL(dir), nil)
						}
					}}),
					setDivider(),
					setRow("会话目录", sessions, ui.Button{Text: T("打开"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
						if sessions != "" {
							a.cx.OpenURL(fileURL(sessions), nil)
						}
					}}),
					setDivider(),
					setRow("pi 的会话目录", a.env.GetUntracked().SessionsDir, ui.Button{Text: T("打开"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
						if sd := a.env.GetUntracked().SessionsDir; sd != "" {
							a.cx.OpenURL(fileURL(sd), nil)
						}
					}}),
				),
				setGroup("数量",
					setRow("本应用的会话", fmt.Sprintf("%d 个", count), ui.Text(T("已打开 %d", len(a.tabs.Get())), 10.5, ui.Regular, colors.Faint)),
					setDivider(),
					setRow("项目下的 pi 本地会话", fmt.Sprintf("%d 个", piCount), nil),
					setDivider(),
					setRow("配置版本", fmt.Sprintf("%d", a.cfg.Version),
						ui.Text("旧文件读取时自动迁移", 10.5, ui.Regular, colors.Faint)),
				),
				setGroup("备份",
					setRow("导出设置包", "配置、插件、主题、提示词、智能体与 ACP 预设打成一个 zip；不含会话与日志。",
						ui.Button{Text: T("导出"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "settings-export",
							OnPress: a.exportSettings}),
					setDivider(),
					setRow("导入设置包", "从 zip 恢复；同名文件会被覆盖，部分设置重启后生效。",
						ui.Button{Text: T("选择…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "settings-import",
							OnPress: a.pickSettingsZip}),
				),
			}},
		}}
	})
}

// settingsAbout is the version and where it comes from.
func (a *app) settingsAbout() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		info := a.env.Get()
		return core.Scroll{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 8, Bottom: 20, Right: 2}, Gap: 12}, Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 12}, Children: []core.Node{
					core.Image{Source: core.ImageSource{Data: logoPNG}, ResizeMode: core.Contain, Label: "PiDeck",
						Style: core.Style{Width: core.Pt(44), Height: core.Pt(44), CornerRadius: 12}},
					core.View{Style: core.Style{Gap: 2}, Children: []core.Node{
						ui.Text("PiDeck Lite", 15, ui.Semibold, colors.Text),
						ui.Text("0.2.0 · NSGo 原生窗口 · 只做 pi", 11, ui.Regular, colors.Muted),
					}},
				}},
				setGroup("运行",
					setRow("操作系统", fmt.Sprintf("%s / %s", runtime.GOOS, runtime.GOARCH), nil),
					setDivider(),
					setRow("pi", piVersionLine(info), nil),
					setDivider(),
					setRow("后端", "pi --mode rpc（会话、工具、模型都由 pi 提供）", nil),
				),
				setGroup("更新",
					setRow("检查更新", "从 GitHub Release 的 appcast 检查；direct 构建会下载、校验并安装。",
						ui.Button{Text: T("检查"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "check-updates",
							OnPress: func() { updater.Check(a.cx) }}),
				),
				setGroup("链接",
					setRow("pi 项目", "github.com/badlogic/pi-mono", ui.Button{Text: T("复制"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
						a.copyText("https://github.com/badlogic/pi-mono", "链接")
					}}),
					setDivider(),
					setRow("NSGo 框架", "nsgo.dev", ui.Button{Text: T("复制"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
						a.copyText("https://nsgo.dev/", "链接")
					}}),
				),
				core.Text{Content: "MIT · 数据都在本机 · 会话由 pi 写入自己的目录",
					Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)},
			}},
		}}
	})
}

// ensure os is used for the folder pickers the sections offer.
var _ = os.Getenv
var _ = filepath.Join

// authGroup lists pi's credentials file with a way to replace a key.
func (a *app) authGroup() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		entries := a.authEntries.Get()
		errText := a.authErr.Get()
		var rows []core.Node
		for _, e := range entries {
			e := e
			detail := e.Type
			if detail == "" {
				detail = T("未声明类型")
			}
			if e.Hint != "" {
				detail += " · " + e.Hint
			}
			var controls []core.Node
			if e.Editable {
				controls = append(controls, ui.Button{Text: T("替换密钥"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
					TestID: "auth-replace-" + e.Provider, OnPress: func() { a.openAuthKey(e.Provider) }})
			}
			controls = append(controls, ui.Button{Text: T("删除"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				TestID: "auth-delete-" + e.Provider, OnPress: func() { a.dropAuthEntry(e.Provider) }})
			rows = append(rows, setRow(e.Provider, detail, core.View{Style: core.Style{Direction: core.Row, Gap: 6}, Children: controls}))
		}
		if len(entries) == 0 && errText == "" {
			rows = append(rows, setRow(T("还没有凭据"), T("在终端里登录 pi，或在这里添加一个 API key。"), nil))
		}
		if errText != "" {
			rows = append(rows, core.Text{Content: errText, Style: core.Style{FontSize: 10.5, Padding: core.Symmetric(3, 6)},
				StyleFunc: ui.Colored(colors.Danger)})
		}
		rows = append(rows, core.View{Style: core.Style{Direction: core.Row, Gap: 6, Margin: core.Edges{Top: 2}}, Children: []core.Node{
			ui.Button{Text: T("添加密钥…"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "auth-add",
				OnPress: func() { a.openAuthKey("") }},
		}})
		return setGroup(T("pi 凭据"), rows...)
	})
}
