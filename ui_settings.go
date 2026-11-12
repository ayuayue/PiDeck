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

	"github.com/oneo-me/nsgo/base"
	"github.com/oneo-me/nsgo/core"
	"github.com/oneo-me/nsgo/icons/lucide"
	"github.com/oneo-me/nsgo/ui"
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
		{"addons", "扩展", lucide.Puzzle, "扩展", "插件给命令面板加提示词，给外观加主题。"},
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
				OnPress: func(core.PressEvent) {
					a.settingsTab.Set(s.ID)
					if s.ID == "remote" && a.remote != nil {
						a.remote.refresh()
					}
					if s.ID == "usage" {
						a.loadUsage(false)
					}
				},
				Role: core.RoleTab, Label: T(s.Label), TestID: "settings-tab-" + s.ID,
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
		Open:         a.settings.Get,
		OnOpenChange: func(open bool, _ base.Reason) { a.settings.Set(open) },
		Bare:         true,
		TestID:       "settings",
		Style:        core.Style{Width: core.Pt(760), Height: core.Pt(560)},
		Children: []core.Node{core.View{Style: core.Style{Direction: core.Row, FlexGrow: 1, MinHeight: core.Pt(0)}, Children: []core.Node{
			// rail
			core.View{StyleFunc: func() core.Style {
				return core.Style{Width: core.Pt(176), Padding: core.All(10), Gap: 2, FlexShrink: 0,
					Background: colors.Inset(), Borders: core.Edges{Right: 1}, BorderColors: core.EdgeColors{Right: colors.Now().Line}}
			}, Children: append([]core.Node{
				core.View{Style: core.Style{Padding: core.Edges{Left: 9, Top: 4, Bottom: 10}}, Children: []core.Node{
					ui.Text("设置", 13, ui.Semibold, colors.Text),
				}},
			}, nav...)},
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
				core.View{Style: core.Style{FlexGrow: 1, MinHeight: core.Pt(0), Padding: core.Edges{Right: 20, Left: 20}}, Children: []core.Node{
					a.settingsContent(),
				}},
				core.View{StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Symmetric(10, 16),
						FlexShrink: 0, Borders: core.Edges{Top: 1}, BorderColors: core.EdgeColors{Top: colors.Now().Line}}
				}, Children: []core.Node{
					ui.Button{Text: "重新检测", Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: a.reloadFrameworks},
					core.View{Style: core.Style{FlexGrow: 1}},
					ui.Button{Text: "完成", Variant: ui.ButtonPrimary, OnPress: func() { a.settings.Set(false) }},
				}},
			}},
		}}},
	}
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
		case "addons":
			return a.settingsAddons()
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
				),
				setGroup("新会话默认模型", core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6, Padding: core.Symmetric(4, 2)},
					Children: modelChips}),
				setGroup("新会话默认思考等级", core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6, Padding: core.Symmetric(4, 2)},
					Children: levelChips}),
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
						ui.Switch{Checked: func() bool { return a.cfg.ScanAll }, Label: "扫描所有项目", OnChange: func(on bool) {
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
						ui.Switch{Checked: func() bool { return a.cfg.ScanPi }, Label: "列出 pi 本地会话", OnChange: func(on bool) {
							a.cfg.ScanPi = on
							a.st.edit(func(c *config) { c.ScanPi = on })
							a.reloadFrameworks()
						}}),
					setDivider(),
					setRow("扫描所有项目", "连没有添加为项目的文件夹也读，会话多时会更慢。",
						ui.Switch{Checked: func() bool { return a.cfg.ScanAll }, Label: "扫描所有项目", OnChange: func(on bool) {
							a.cfg.ScanAll = on
							a.st.edit(func(c *config) { c.ScanAll = on })
							a.reloadFrameworks()
						}}),
				),
				setGroup("桌面",
					setRow("关闭窗口时留在托盘", "关掉窗口不退出应用，Agent 继续跑；从托盘图标恢复窗口。",
						ui.Switch{Checked: func() bool { return a.cfg.CloseToTray }, Label: "关闭窗口时留在托盘", TestID: "close-to-tray",
							OnChange: func(on bool) {
								a.cfg.CloseToTray = on
								a.st.edit(func(c *config) { c.CloseToTray = on })
							}}),
					setDivider(),
					setRow("一轮完成时通知", "用系统通知告诉你回答好了；运行中的会话也会显示在托盘菜单里。",
						ui.Switch{Checked: func() bool { return a.cfg.NotifyOnDone }, Label: "一轮完成时通知", TestID: "notify-done",
							OnChange: func(on bool) {
								a.cfg.NotifyOnDone = on
								a.st.edit(func(c *config) { c.NotifyOnDone = on })
							}}),
					setDivider(),
					setRow("只在窗口隐藏时通知", "窗口在前台时不再弹系统通知。",
						ui.Switch{Checked: func() bool { return a.cfg.NotifyOnlyHidden }, Label: "只在窗口隐藏时通知", TestID: "notify-hidden",
							OnChange: func(on bool) {
								a.cfg.NotifyOnlyHidden = on
								a.st.edit(func(c *config) { c.NotifyOnlyHidden = on })
							}}),
					setDivider(),
					setRow("测试通知", "发一条系统通知，确认这台机器收得到。",
						ui.Button{Text: "发一条", Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
							notifyDesktop("PiDeck Lite", "通知已开启，一轮完成时会这样提醒。")
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
				ui.IconButton{Icon: lucide.Settings2, Label: "配置 " + prov.ID, Size: 26, IconSize: 13,
					TestID: "provider-configure-" + prov.ID, OnPress: func() { a.openProviderDialog(prov.ID) }},
				arrowButton(lucide.ArrowUpToLine, "置顶供应商", func() { a.pinProvider(prov.ID) }),
				arrowButton(lucide.ChevronUp, "上移供应商", func() { a.moveProvider(prov.ID, -1) }),
				arrowButton(lucide.ChevronDown, "下移供应商", func() { a.moveProvider(prov.ID, 1) }),
				core.View{OnPress: func(core.PressEvent) { a.copyText(loginCommand(prov), "登录命令") }, Role: core.RoleButton,
					Label: "复制登录命令",
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
				}, Role: core.RoleButton, Label: "取消收藏 " + id,
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
		return core.Scroll{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: 2}}, Children: []core.Node{
				setGroup("常用模型", core.View{Style: core.Style{Gap: 1}, Children: favRows}),
				setGroup("供应商与认证", rows...),
				core.Text{Content: "凭据由 pi 管理（~/.pi/agent/auth.json）。在终端里执行登录命令后，点下方的「重新检测」。",
					Style: core.Style{FontSize: 11, LineHeight: 17}, StyleFunc: ui.Colored(colors.Faint)},
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6, Margin: core.Edges{Top: 2}}, Children: []core.Node{
					ui.Button{Text: "编辑 models.json", Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						OnPress: func() { a.openPiConfigFile("models.json") }},
					ui.Button{Text: "编辑 settings.json", Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						OnPress: func() { a.openPiConfigFile("settings.json") }},
					ui.Button{Text: "编辑 auth.json", Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						OnPress: func() { a.openPiConfigFile("auth.json") }},
					ui.Button{Text: "重新检测", Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: a.refreshProviders},
				}},
			}},
		}}
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
				Placeholder: "如 mod+shift+r",
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
			reset := ui.Button{Text: "默认", Variant: ui.ButtonGhost, Size: ui.SizeSmall,
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
					ui.Button{Text: "全部恢复默认", Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: a.resetKeybindings},
				}},
			}},
		}}
	})
}

// settingsLook picks the palette.
func (a *app) settingsLook() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		var rows []core.Node
		list := a.themes.Get()
		for i, spec := range list {
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
					core.View{StyleFunc: func() core.Style {
						return core.Style{Width: core.Pt(28), Height: core.Pt(18), CornerRadius: 4, Background: s.swatch(),
							BorderWidth: 1, BorderColor: colors.Border()}
					}},
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
					core.Show{When: on, Then: func(*core.Scope) core.Node { return ui.Icon(lucide.Check, 13, colors.Text) }},
					core.Show{When: func() bool { return !s.Builtin }, Then: func(*core.Scope) core.Node {
						return ui.Text("用户主题", 9.5, ui.Regular, colors.Faint)
					}},
				},
			})
			if i < len(list)-1 {
				rows = append(rows, setDivider())
			}
		}
		return core.Scroll{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: 2}, Gap: 4}, Children: []core.Node{
				setGroup("配色", rows...),
				setRow("主题文件", "放在数据目录的 themes 里：JSON 或 YAML，写角色色、tokens、字体与圆角；也读 shadcn/ui 主题文件。",
					ui.Button{Text: "打开目录", Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() {
						a.openThemesDir()
					}}),
				core.Text{Content: "角色：background surface border text textMuted accent danger warning success selection focus scrollbar inset raised field line faint code info track knob。",
					Style: core.Style{FontSize: 11, LineHeight: 17}, StyleFunc: ui.Colored(colors.Faint)},
			}},
		}}
	})
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
			setRow("pi 会话目录", info.SessionsDir, ui.Button{Text: "打开", Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
				if info.SessionsDir != "" {
					a.cx.OpenURL(fileURL(info.SessionsDir), nil)
				}
			}}),
			setDivider(),
			setRow("pi 配置目录", piConfigDir(), ui.Button{Text: "打开", Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
				if dir := piConfigDir(); dir != "" {
					a.cx.OpenURL(fileURL(dir), nil)
				}
			}}),
		)
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
				setGroup("其它机器", targets...),
				core.View{Style: core.Style{Direction: core.Row, Gap: 8, Margin: core.Edges{Top: 4}}, Children: []core.Node{
					ui.Button{Text: "添加 WSL 工作区", Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() {
						a.settings.Set(false)
						a.openTargetDialog(targetWSL)
					}},
					ui.Button{Text: "添加 SSH 工作区", Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() {
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
					Label:   "启用 " + plug.Name,
					Size:    ui.SizeSmall,
					TestID:  "plugin-toggle-" + plug.ID,
					OnChange: func(on bool) {
						a.setPluginEnabled(plug.ID, on)
					},
				}
			} else {
				control = ui.Text("无法读取", 10.5, ui.Regular, colors.Danger)
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
				lines = append(lines, core.Text{Content: "注意：" + w, Style: core.Style{FontSize: 10.5},
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
				lines = append(lines, core.Text{Content: "· 主题 " + th.Name, Style: core.Style{FontSize: 10.5},
					StyleFunc: ui.Colored(colors.Muted)})
			}
			for _, kb := range plug.Contributes.Keybindings {
				lines = append(lines, core.Text{Content: "· 键位 " + kb.Key + " → " + kb.Command,
					Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)})
			}
			if len(lines) > 0 {
				rows = append(rows, core.View{Style: core.Style{Padding: core.Edges{Left: 4, Bottom: 4}, Gap: 1}, Children: lines})
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
					ui.Button{Text: "打开插件目录", Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() {
						a.openPluginsDir()
					}},
					ui.Button{Text: "重新加载", Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: a.reloadAddons},
				}},
			}},
		}}
	})
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
			count = len(a.st.scanSessions(a.cfg.Titles))
		}
		piCount := 0
		for _, ws := range a.workspaces.Get() {
			piCount += len(ws.Pi.Get())
		}
		return core.Scroll{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: 2}, Gap: 2}, Children: []core.Node{
				setGroup("位置",
					setRow("数据目录", dir, ui.Button{Text: "打开", Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
						if dir != "" {
							a.cx.OpenURL(fileURL(dir), nil)
						}
					}}),
					setDivider(),
					setRow("会话目录", sessions, ui.Button{Text: "打开", Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
						if sessions != "" {
							a.cx.OpenURL(fileURL(sessions), nil)
						}
					}}),
					setDivider(),
					setRow("pi 的会话目录", a.env.GetUntracked().SessionsDir, ui.Button{Text: "打开", Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
						if sd := a.env.GetUntracked().SessionsDir; sd != "" {
							a.cx.OpenURL(fileURL(sd), nil)
						}
					}}),
				),
				setGroup("数量",
					setRow("本应用的会话", fmt.Sprintf("%d 个", count), ui.Text("已打开 "+fmt.Sprint(len(a.tabs.Get())), 10.5, ui.Regular, colors.Faint)),
					setDivider(),
					setRow("项目下的 pi 本地会话", fmt.Sprintf("%d 个", piCount), nil),
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
				setGroup("链接",
					setRow("pi 项目", "github.com/badlogic/pi-mono", ui.Button{Text: "复制", Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
						a.copyText("https://github.com/badlogic/pi-mono", "链接")
					}}),
					setDivider(),
					setRow("NSGo 框架", "oneo-me.github.io/nsgo", ui.Button{Text: "复制", Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
						a.copyText("https://oneo-me.github.io/nsgo/", "链接")
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
