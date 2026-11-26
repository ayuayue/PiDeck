package client

// The phone's workbench, laid out like the desktop's: the rail of projects
// and sessions, and beside it the page that starts a session or shows the
// open one. A phone has no room for both columns, so the rail slides over
// the page in a drawer; a tablet or a browser window wide enough keeps it
// beside the page, where the desktop puts it.

import (
	"fmt"
	"strings"

	"example.com/pideck-v2/assets"
	"example.com/pideck-v2/internal/appinfo"
	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// The rail's width on a phone, and the least window that keeps it beside
// the page instead of sliding over it.
const (
	railWidth       core.Points = 296
	railBesideWidth core.Points = 820
)

// railBeside says the window is wide enough to keep the rail open beside
// the page.
func railBeside(cx *core.Scope) bool { return cx.Env().Window().Width >= railBesideWidth }

// railShown is whether the rail shows beside the page: wide enough for two
// columns, and the user has not folded it away.
func (a *mobileApp) railShown(cx *core.Scope) bool { return railBeside(cx) && !a.railHidden.Get() }

// shell is the rail and the page: side by side in a wide window, the rail
// in a drawer over the page in a narrow one.
func (a *mobileApp) shell(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{Style: core.Style{Direction: core.Row, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), MinHeight: core.Pt(0),
		PaddingEnv: core.EnvAll(core.EnvSafeArea)}, StyleFunc: ui.Filled(colors.Background), Children: []core.Node{
		core.Show{When: func() bool { return a.railShown(cx) }, Then: func(*core.Scope) core.Node {
			return core.View{Style: core.Style{Width: core.Pt(railWidth), FlexShrink: 0, Height: core.Pct(100),
				Borders: core.Edges{Right: 1}, BorderColors: core.EdgeColors{Right: colors.Line()}}, Children: []core.Node{a.rail(cx)}}
		}},
		core.View{Style: ui.FillRest, Children: []core.Node{
			core.Dynamic(func(cx *core.Scope) core.Node {
				if a.active.Get() != "" {
					return a.transcriptView(cx)
				}
				return a.initView(cx)
			}),
		}},
	}}
}

// drawer is the rail over the page on a phone: the same rail the desktop
// keeps open, sliding in from the left.
func (a *mobileApp) drawer() core.Node {
	return base.Sheet{
		Open:         func() bool { return a.drawerOpen.Get() && !railBeside(a.cx) },
		OnOpenChange: func(open bool, _ base.Reason) { a.drawerOpen.Set(open) },
		Side:         core.PlaceLeft,
		BackdropStyle: core.Style{
			Background: ui.Black(0.32),
		},
		PopupStyleFunc: func() core.Style {
			env := a.cx.Env()
			colors := ui.ColorsOf(a.cx)
			return core.Style{Width: core.Pt(min(railWidth, env.Window().Width*0.88)), Height: core.Pct(100),
				Background: colors.Inset(), Color: colors.Text(),
				PaddingEnv: core.EnvAll(core.EnvSafeArea)}
		},
		Label:  apptext.T("项目与会话"),
		TestID: "mobile-drawer-sheet",
		Children: []core.Node{
			core.Dynamic(func(cx *core.Scope) core.Node { return a.rail(cx) }),
		},
	}
}

// openDrawer shows or hides the rail.
func (a *mobileApp) openDrawer(open bool) { a.drawerOpen.Set(open) }

// rail is what the desktop's side rail holds: the brand, the ways in, the
// projects and their sessions, and the settings at the bottom.
func (a *mobileApp) rail(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{Style: ui.FillRest, StyleFunc: ui.Filled(colors.Inset), Children: []core.Node{
		core.Scroll{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 14, Right: 8, Bottom: 12, Left: 10}, Gap: 9}, Children: []core.Node{
				a.railBrand(cx),
				a.railNewButton(cx),
				core.View{Style: core.Style{Gap: 1}, Children: []core.Node{
					a.railEntry(lucide.Search, apptext.T("搜索会话"), "mobile-search", func() { a.openSearch() }),
					a.railEntry(lucide.GitPullRequest, apptext.T("评审"), "mobile-review", func() { a.openReview() }),
					a.railEntry(lucide.Bot, apptext.T("智能体"), "mobile-agents", func() { a.openAgents() }),
					a.railEntry(lucide.CalendarClock, apptext.T("定时任务"), "mobile-tasks", func() { a.openTasks() }),
					a.railEntry(lucide.Star, apptext.T("收藏"), "mobile-favorites", func() { a.openFavorites() }),
				}},
				a.railProjects(cx),
			}},
		}},
		a.railFooter(cx),
	}}
}

// railBrand is the tile, the wordmark and the computer it talks to.
func (a *mobileApp) railBrand(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, Padding: core.Edges{Top: 2, Right: 0, Bottom: 2, Left: 4}},
		Children: []core.Node{
			core.Image{Source: core.ImageSource{Data: assets.LogoPNG}, ResizeMode: core.Contain, Label: "PiDeck",
				Style: core.Style{Width: core.Pt(32), Height: core.Pt(32), CornerRadius: 9}},
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5}, Children: []core.Node{
					core.Text{Content: "PiDeck", Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 14.5, FontWeight: ui.Bold, LetterSpacing: 0.4},
						StyleFunc: ui.Colored(colors.Text)},
					core.View{StyleFunc: func() core.Style {
						return core.Style{Padding: core.Symmetric(1, 5), CornerRadius: 4, BorderWidth: 1, BorderColor: colors.Border()}
					}, Children: []core.Node{core.Text{Content: "v" + appinfo.Version, TestID: "mobile-brand-version",
						Style:     core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9},
						StyleFunc: ui.Colored(colors.Faint)}}},
				}},
				core.Text{ContentFunc: func() string {
					name := strings.TrimSpace(a.serverName.Get())
					if name == "" {
						name = "PiDeck V2"
					}
					return apptext.T("电脑") + " · " + name
				}, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle, Style: core.Style{FontSize: 10},
					StyleFunc: ui.Colored(colors.Muted)},
			}},
			// The list refreshes itself every couple of seconds; the button
			// shows only while it is reading, or when the last read failed.
			core.Dynamic(func(cx *core.Scope) core.Node {
				if a.busyMark.Get() {
					return core.View{Style: core.Style{Width: core.Pt(30), Height: core.Pt(30), AlignItems: core.AlignCenter,
						JustifyContent: core.JustifyCenter}, Children: []core.Node{ui.Spinner{Size: 11, Label: apptext.T("刷新")}}}
				}
				if a.err.Get() != "" {
					return a.pressIcon(lucide.RefreshCw, apptext.T("重试"), 30, 14, nil, a.refreshState, "mobile-refresh")
				}
				return nil
			}),
		}}
}

// railNewButton is the rail's main action, the desktop's button in the
// phone's size.
func (a *mobileApp) railNewButton(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{OnPress: func(core.PressEvent) { a.startNewSession() }, Role: core.RoleButton, Label: apptext.T("新建会话"),
		TestID: "mobile-new",
		StyleFunc: func() core.Style {
			p := colors.Now()
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(38), Padding: core.Symmetric(0, 11),
				CornerRadius: ui.RadiusControl, Background: colors.Light(), Color: colors.OnLight(), Transition: viewkit.PressMotion,
				Hover: &core.Style{Background: p.AccentHover}, Active: &core.Style{Background: p.AccentPressed}}
		}, Children: []core.Node{
			ui.Icon(lucide.Plus, 15, colors.OnLight),
			core.Text{Content: apptext.T("新建会话"), Style: core.Style{FlexGrow: 1, FontSize: 13.5, FontWeight: ui.Semibold},
				StyleFunc: ui.Colored(colors.OnLight)},
			core.Show{When: func() bool { return a.creating.Get() }, Then: func(*core.Scope) core.Node {
				return ui.Spinner{Size: 12, Label: apptext.T("新建会话")}
			}},
		}}
}

// railEntry is one of the rail's ways in: search, agents, tasks, favorites.
func (a *mobileApp) railEntry(icon func() *core.SVG, label, testID string, press func()) core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{OnPress: func(core.PressEvent) { press() }, Role: core.RoleButton, Label: apptext.T(label), TestID: testID,
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, MinHeight: core.Pt(40), Padding: core.Symmetric(0, 8),
				CornerRadius: 8, Transition: viewkit.PressMotion, Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{ui.Icon(icon, 15, colors.Muted), ui.Text(apptext.T(label), 13.5, ui.Medium, colors.Text)}}
}

// railProjects is the project tree: each project and the sessions under it.
func (a *mobileApp) railProjects(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{Style: core.Style{Gap: 2, Margin: core.Edges{Top: 4}}, Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Symmetric(2, 8)},
			Children: []core.Node{
				core.Text{Content: apptext.T("项目"), Style: core.Style{FontSize: 10, FontWeight: ui.Semibold, LetterSpacing: 0.6},
					StyleFunc: ui.Colored(colors.Faint)},
				core.View{Style: core.Style{FlexGrow: 1}},
				core.Text{ContentFunc: func() string { return fmt.Sprint(len(a.state.Get().Projects)) },
					Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
				a.pressIcon(lucide.FolderPlus, apptext.T("添加项目"), 28, 13, nil, func() {
					a.addPath.Set("")
					a.addOpen.Set(true)
				}, "mobile-add-project"),
			}},
		core.Dynamic(func(cx *core.Scope) core.Node {
			projects := a.state.Get().Projects
			if len(projects) == 0 {
				return core.View{Style: core.Style{Padding: core.Edges{Top: 4, Right: 8, Bottom: 8, Left: 8}, Gap: 2}, Children: []core.Node{
					ui.Text(apptext.T("电脑上还没有项目"), 11.5, ui.Regular, colors.Faint),
					ui.Text(apptext.T("在电脑端点「添加工作区」，或者在这里填一个文件夹。"), 10.5, ui.Regular, colors.Faint),
				}}
			}
			blocks := make([]core.Node, 0, len(projects))
			for i, p := range projects {
				blocks = append(blocks, a.railProject(cx, i, p))
			}
			return core.View{Style: core.Style{Gap: 2}, Children: blocks}
		}),
	}}
}

// railProject is one project and, when open, its sessions.
func (a *mobileApp) railProject(cx *core.Scope, index int, p remotewire.Project) core.Node {
	colors := ui.ColorsOf(cx)
	open := func() bool { return !a.projectCollapsed(p.Path) }
	return core.View{Style: core.Style{Gap: 1}, Children: []core.Node{
		core.View{OnPress: func(core.PressEvent) { a.toggleProject(p.Path) }, Role: core.RoleButton, Label: p.Name,
			TestID: fmt.Sprintf("mobile-project-%d", index),
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, MinHeight: core.Pt(38),
					Padding: core.Edges{Left: 6, Right: 2}, CornerRadius: 8, Transition: viewkit.PressMotion,
					Active: &core.Style{Background: colors.Pressed()}}
			},
			Children: []core.Node{
				ui.IconOf(func() *core.SVG {
					if open() {
						return lucide.ChevronDown()
					}
					return lucide.ChevronRight()
				}, 12, colors.Faint),
				ui.IconOf(func() *core.SVG {
					if open() {
						return lucide.FolderOpen()
					}
					return lucide.Folder()
				}, 14, colors.Muted),
				core.Text{Content: p.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
					Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12.5, FontWeight: ui.Medium},
					StyleFunc: ui.Colored(colors.Text)},
				core.Text{Content: fmt.Sprint(len(p.Sessions)), Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5},
					StyleFunc: ui.Colored(colors.Faint)},
				a.pressIcon(lucide.Ellipsis, apptext.T("项目操作"), 28, 14, nil, func() { a.projectOpen.Set(p.Path) },
					fmt.Sprintf("mobile-project-more-%d", index)),
			}},
		core.Show{When: open, Then: func(cx *core.Scope) core.Node {
			if len(p.Sessions) == 0 {
				return core.View{Style: core.Style{Padding: core.Edges{Left: 28, Top: 2, Bottom: 4}}, Children: []core.Node{
					ui.Text(apptext.T("还没有会话"), 11, ui.Regular, colors.Faint),
				}}
			}
			return a.railSessionRows(cx, p.Path, p.Sessions)
		}},
	}}
}

// railFooter is the bottom bar: the settings and the theme.
func (a *mobileApp) railFooter(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{StyleFunc: func() core.Style {
		return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, FlexShrink: 0, Padding: core.Symmetric(6, 8),
			Borders: core.Edges{Top: 1}, BorderColors: core.EdgeColors{Top: colors.Line()}}
	}, Children: []core.Node{
		core.View{OnPress: func(core.PressEvent) { a.openSettings() }, Role: core.RoleButton, Label: apptext.T("设置"),
			TestID: "mobile-settings",
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, FlexGrow: 1, MinHeight: core.Pt(38),
					Padding: core.Symmetric(0, 8), CornerRadius: 8, Transition: viewkit.PressMotion, Active: &core.Style{Background: colors.Pressed()}}
			},
			Children: []core.Node{
				ui.Icon(lucide.Settings, 15, colors.Muted),
				core.Text{Content: apptext.T("设置"), Style: core.Style{FontSize: 13}, StyleFunc: ui.Colored(colors.Text)},
			}},
		a.themeButton(cx),
	}}
}

// themeButton shows the look the phone is in and steps to the next one.
func (a *mobileApp) themeButton(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	icon := func() *core.SVG {
		switch a.appearance.Get() {
		case appearanceLight:
			return lucide.Sun()
		case appearanceDark:
			return lucide.Moon()
		}
		return lucide.Monitor()
	}
	label := func() string { return appearanceName(a.appearance.Get()) }
	return core.View{OnPress: func(core.PressEvent) { a.cycleAppearance() }, Role: core.RoleButton,
		LabelFunc: func() string { return apptext.T("外观") + "：" + label() }, TestID: "mobile-theme",
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, MinHeight: core.Pt(38),
				Padding: core.Symmetric(0, 9), CornerRadius: 8, Transition: viewkit.PressMotion, Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{
			ui.IconOf(icon, 15, colors.Muted),
			core.Text{ContentFunc: label, MaxLines: 1, Style: core.Style{FontSize: 12}, StyleFunc: ui.Colored(colors.Muted)},
		}}
}

// pageHeader is the bar over a page: the rail's toggle, the title, and the
// page's actions. On a phone the toggle opens the drawer; in a window wide
// enough to hold both columns it folds the rail away and back.
func (a *mobileApp) pageHeader(cx *core.Scope, title, subtitle string, actions ...core.Node) core.Node {
	colors := ui.ColorsOf(cx)
	var leading []core.Node
	if railBeside(cx) {
		leading = append(leading, a.pressIcon(lucide.PanelLeft, apptext.T("侧栏"), 38, 18, nil,
			func() { a.railHidden.Update(func(hidden bool) bool { return !hidden }) }, "mobile-rail-toggle"))
	} else {
		leading = append(leading, a.pressIcon(lucide.PanelLeft, apptext.T("项目与会话"), 38, 18, nil,
			func() { a.openDrawer(true) }, "mobile-drawer"))
	}
	children := append(leading, core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 0}, Children: []core.Node{
		core.Text{Content: title, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
			Style: core.Style{FontSize: 15, FontWeight: ui.Semibold}, StyleFunc: ui.Colored(colors.Text)},
		core.Show{When: func() bool { return subtitle != "" }, Then: func(*core.Scope) core.Node {
			return core.Text{Content: subtitle, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)}
		}},
	}})
	children = append(children, core.Dynamic(func(*core.Scope) core.Node {
		if a.busyMark.Get() {
			return ui.Spinner{Size: 12, Label: apptext.T("刷新")}
		}
		return nil
	}))
	children = append(children, actions...)
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinHeight: core.Pt(52),
		Padding: core.Symmetric(0, 10), FlexShrink: 0, Borders: core.Edges{Bottom: 1},
		BorderColors: core.EdgeColors{Bottom: colors.Line()}, Background: colors.Surface()}, Children: children}
}

// initView is the page the phone opens on: pick a project, write the first
// line, and the session starts on the desktop.
func (a *mobileApp) initView(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{Style: ui.FillRest, StyleFunc: ui.Filled(colors.Background), Children: []core.Node{
		a.pageHeader(cx, "PiDeck V2", a.serverName.Get()),
		a.appNotice(cx),
		core.Scroll{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{FlexGrow: 1, MinHeight: core.Pct(100), Padding: core.Edges{Top: 24, Right: 20, Bottom: 6, Left: 20},
				AlignItems: core.AlignCenter}, Children: []core.Node{
				core.View{Style: core.Style{FlexGrow: 1, Width: core.Pct(100), MaxWidth: core.Pt(520), AlignItems: core.AlignCenter,
					JustifyContent: core.JustifyCenter, Gap: 12}, Children: []core.Node{
					core.Image{Source: core.ImageSource{Data: assets.LogoPNG}, ResizeMode: core.Contain, Label: "PiDeck",
						Style: core.Style{Width: core.Pt(56), Height: core.Pt(56), CornerRadius: 16}},
					core.View{Style: core.Style{Gap: 5, AlignItems: core.AlignCenter}, Children: []core.Node{
						ui.Text(apptext.T("开始新的会话"), 21, ui.Semibold, colors.Text),
						core.Text{ContentFunc: func() string {
							return apptext.T("会话跑在电脑上的 pi 里，手机上接着看、接着写。")
						}, Style: core.Style{FontSize: 12.5, LineHeight: 19, TextAlign: core.TextAlignCenter},
							StyleFunc: ui.Colored(colors.Muted)},
					}},
					a.initProjectChip(cx),
				}},
				a.initComposer(cx),
			}},
		}},
	}}
}

// initProjectChip picks the project the new session belongs to.
func (a *mobileApp) initProjectChip(cx *core.Scope) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		path := a.initProjectPath()
		empty := path == ""
		label := a.projectName(path)
		if empty {
			label = apptext.T("还没有项目")
		}
		return core.View{OnPress: func(core.PressEvent) {
			if empty {
				a.addPath.Set("")
				a.addOpen.Set(true)
				return
			}
			a.newOpen.Set(true)
		}, Role: core.RoleButton, Label: apptext.T("项目") + "：" + label, TestID: "mobile-init-project",
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, MinHeight: core.Pt(38), Padding: core.Symmetric(0, 13),
					CornerRadius: 19, BorderWidth: 1, BorderColor: colors.FieldBorder(), Background: colors.Surface(),
					Transition: viewkit.PressMotion, Active: &core.Style{Background: colors.Pressed()}}
			},
			Children: []core.Node{
				ui.Icon(lucide.Folder, 13, colors.Muted),
				core.Text{Content: label, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
					Style: core.Style{MaxWidth: core.Pt(240), FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
				core.Show{When: func() bool { return !empty }, Then: func(*core.Scope) core.Node {
					return ui.Icon(lucide.ChevronDown, 12, colors.Faint)
				}},
			}}
	})
}

// initComposer is the first message: writing one starts the session. It is
// the open session's card, so the model, the thinking level, the picture
// button and the usage sit in the same row on both pages.
func (a *mobileApp) initComposer(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{Style: core.Style{Width: core.Pct(100), MaxWidth: core.Pt(520), Gap: 8, Padding: core.Edges{Top: 10},
		PaddingEnv: core.EnvEdges{Bottom: core.EnvKeyboard}}, Children: []core.Node{
		a.initProjectNotice(cx),
		a.composerCard(cx, composerSource{
			draft: a.initDraft.Get, setDraft: a.initDraft.Set,
			pending: a.initPending.Get,
			drop: func(index int) {
				a.initPending.Update(func(list []remotewire.Image) []remotewire.Image { return withoutImage(list, index) })
			},
			pick: a.pickInitImage, send: a.sendInit, sending: a.initSending.Get,
			openOptions: a.openInitOptions, placeholder: "写下第一句话…",
		}),
		core.Text{Content: apptext.T("新会话在电脑上跑：手机锁屏或掉线都不影响这一轮。"), Style: core.Style{FontSize: 10.5, TextAlign: core.TextAlignCenter},
			StyleFunc: ui.Colored(colors.Faint)},
	}}
}

// initProjectNotice says the page has no project to start in, so the send
// button cannot work: a disabled button alone would look broken.
func (a *mobileApp) initProjectNotice(cx *core.Scope) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		// Follow the project list, so the notice leaves once the drawer adds
		// one. An empty snapshot before the first answer is not a desktop
		// without projects.
		snap := a.state.Get()
		if len(snap.Projects) > 0 || snap.Name == "" {
			return nil
		}
		colors := ui.ColorsOf(cx)
		return core.View{TestID: "mobile-no-project",
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Padding: core.Symmetric(8, 11),
					CornerRadius: 10, Background: ui.Alpha(colors.Warn(), 0.10),
					BorderWidth: 1, BorderColor: ui.Alpha(colors.Warn(), 0.35)}
			}, Children: []core.Node{
				ui.Icon(lucide.FolderPlus, 14, colors.Warn),
				core.Text{Content: apptext.T("先在抽屉里添加一个项目，才能新建会话。"), MaxLines: 2,
					Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11.5, LineHeight: 16},
					StyleFunc: ui.Colored(colors.Text)},
			}}
	})
}

// projectName is a project's label, or nothing when the path is unknown.
func (a *mobileApp) projectName(path string) string {
	if path == "" {
		return ""
	}
	for _, p := range a.state.Get().Projects {
		if p.Path == path {
			return p.Name
		}
	}
	return ""
}

// initProjectPath is the project a new session starts in: the one picked,
// else the last used, else the first on the desktop.
func (a *mobileApp) initProjectPath() string {
	chosen := strings.TrimSpace(a.initProject.GetUntracked())
	projects := a.state.GetUntracked().Projects
	for _, p := range projects {
		if p.Path == chosen {
			return p.Path
		}
	}
	if len(projects) > 0 {
		return projects[0].Path
	}
	return ""
}

// sendInit starts a session with the first message and opens it.
func (a *mobileApp) sendInit() {
	client := a.client
	project := a.initProjectPath()
	text := strings.TrimSpace(a.initDraft.GetUntracked())
	images := a.initPending.GetUntracked()
	if client == nil || a.initSending.GetUntracked() || (text == "" && len(images) == 0) {
		return
	}
	if project == "" {
		a.err.Set(apptext.T("电脑上还没有项目，先在抽屉里添加一个"))
		return
	}
	a.initSending.Set(true)
	a.err.Set("")
	go func() {
		id, title, err := client.createSession(project)
		var sent error
		if err == nil && (text != "" || len(images) > 0) {
			sent = client.promptWithImages(id, text, images)
		}
		a.cx.Post(func() {
			a.initSending.Set(false)
			if err != nil {
				a.err.Set(remoteErrorText(err))
				return
			}
			a.initDraft.Set("")
			a.initPending.Set(nil)
			a.initProject.Set(project)
			a.saveLook()
			a.openSession(id, title)
			if sent != nil {
				// The session started but the first message did not go out:
				// put it back in the composer so nothing typed is lost.
				a.draft.Set(text)
				a.pending.Set(images)
				a.sendErr.Set(remoteErrorText(sent))
			}
			a.refreshState()
		})
	}()
}

// pickInitImage adds pictures to the first message.
func (a *mobileApp) pickInitImage() {
	a.cx.PickFiles(core.PickFilesOptions{Types: []string{"image/*"}, Multiple: true, Limit: 4}, func(files []core.File, err error) {
		if err != nil {
			return
		}
		for _, file := range files {
			data, readErr := readImageFile(file.Path)
			if readErr != nil {
				a.flash(readErr.Error())
				continue
			}
			a.initPending.Update(func(list []remotewire.Image) []remotewire.Image { return append(list, data) })
		}
	})
}

// openSettings shows the settings sheet.
func (a *mobileApp) openSettings() {
	a.drawerOpen.Set(false)
	a.settingsOpen.Set(true)
}

// settingsSheet is the phone's settings: what it is connected to, the
// language, the look, and the way out.
func (a *mobileApp) settingsSheet() core.Node {
	return ui.Dialog{
		Open:         func() bool { return a.settingsOpen.Get() },
		OnOpenChange: func(open bool, _ base.Reason) { a.settingsOpen.Set(open) },
		Title:        apptext.T("设置"),
		TestID:       "mobile-settings-sheet",
		Style:        core.Style{Width: core.Pct(100), MaxWidth: core.Pt(520)},
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			field := func(label, value string) core.Node {
				return core.View{Style: core.Style{Gap: 1}, Children: []core.Node{
					ui.Text(label, 10.5, ui.Medium, colors.Faint),
					core.Text{Content: value, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11.5}, StyleFunc: ui.Colored(colors.Text)},
				}}
			}
			version := a.desktopVersion.Get()
			if version == "" {
				version = "—"
			}
			return core.View{Style: core.Style{Gap: 14}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 7}, Children: []core.Node{
					ui.Text(apptext.T("连接"), 11, ui.Medium, colors.Faint),
					core.View{StyleFunc: func() core.Style {
						return core.Style{Gap: 7, Padding: core.All(11), CornerRadius: 10, Background: colors.Inset()}
					}, Children: []core.Node{
						field(apptext.T("电脑"), a.server.Get()),
						field(apptext.T("版本"), apptext.T("%s · 手机端 %s", version, appinfo.Version)),
					}},
				}},
				core.View{Style: core.Style{Gap: 7}, Children: []core.Node{
					ui.Text(apptext.T("语言"), 11, ui.Medium, colors.Faint),
					a.choiceRow(apptext.SupportedLanguages, apptext.LanguageName,
						func() string { return a.language.Get() },
						func(code string) { a.chooseLanguage(code) }, "mobile-lang"),
				}},
				core.View{Style: core.Style{Gap: 7}, Children: []core.Node{
					ui.Text(apptext.T("外观"), 11, ui.Medium, colors.Faint),
					a.choiceRow([]string{appearanceSystem, appearanceLight, appearanceDark}, appearanceName,
						func() string { return a.appearance.Get() },
						func(code string) { a.chooseAppearance(code) }, "mobile-look"),
				}},
				core.View{Style: core.Style{Gap: 7}, Children: []core.Node{
					ui.Text(apptext.T("提示音"), 11, ui.Medium, colors.Faint),
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10}, Children: []core.Node{
						core.Text{ContentFunc: func() string {
							if a.soundOn.Get() {
								return apptext.T("一轮结束或等你确认时，手机会响一声。")
							}
							return apptext.T("关闭时不出声。")
						}, MaxLines: 2, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11.5, LineHeight: 17},
							StyleFunc: ui.Colored(colors.Muted)},
						ui.Switch{Checked: func() bool { return a.soundOn.Get() }, Label: apptext.T("提示音"),
							TestID: "mobile-sound", OnChange: a.setSoundOn},
					}},
					core.Show{When: func() bool { return a.soundOn.Get() }, Then: func(*core.Scope) core.Node {
						return a.choiceRow(phoneSoundChoices(), phoneSoundName,
							func() string { return a.soundName.Get() }, a.setSoundName, "mobile-sound-name")
					}},
				}},
				core.View{Style: core.Style{Gap: 2, Margin: core.Edges{Top: 2}}, Children: []core.Node{
					a.notificationSettings(colors),
					a.sheetRow(lucide.RefreshCw, apptext.T("刷新"), colors.Text, func() {
						a.settingsOpen.Set(false)
						a.refreshState()
					}, "mobile-settings-refresh"),
					a.sheetRow(lucide.Unplug, apptext.T("断开连接"), colors.Danger, func() {
						a.settingsOpen.Set(false)
						a.disconnect()
					}, "mobile-disconnect"),
				}},
			}}
		})},
	}
}

// choiceRow is a row of the settings' pick-one chips.
func (a *mobileApp) choiceRow(values []string, label func(string) string, chosen func() string,
	pick func(string), testID string) core.Node {
	colors := ui.ColorsOf(a.cx)
	chips := make([]core.Node, 0, len(values))
	for _, v := range values {
		value := v
		chips = append(chips, core.View{OnPress: func(core.PressEvent) { pick(value) }, Role: core.RoleButton,
			Label: label(value), TestID: testID,
			StyleFunc: func() core.Style {
				on := chosen() == value
				st := core.Style{Padding: core.Symmetric(6, 13), CornerRadius: 15, BorderWidth: 1, Transition: viewkit.PressMotion,
					BorderColor: colors.FieldBorder(), Background: colors.Surface(),
					Active: &core.Style{Background: colors.Pressed()}}
				if on {
					st.Background = colors.Light()
					st.BorderColor = colors.Light()
				}
				return st
			},
			Children: []core.Node{ui.Text(label(value), 12, ui.Medium, func() core.Color {
				if chosen() == value {
					return colors.OnLight()
				}
				return colors.Muted()
			})}})
	}
	return core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: chips}
}

// The looks the phone can be left in, as remote.json spells them.
const (
	appearanceSystem = ""
	appearanceLight  = "light"
	appearanceDark   = "dark"
)

// appearanceName labels one of them.
func appearanceName(code string) string {
	switch code {
	case appearanceLight:
		return apptext.T("浅色")
	case appearanceDark:
		return apptext.T("深色")
	}
	return apptext.T("跟随系统")
}

// appearanceOf is one as core reads it.
func appearanceOf(code string) core.Appearance {
	switch code {
	case appearanceLight:
		return core.AppearanceLight
	case appearanceDark:
		return core.AppearanceDark
	}
	return core.AppearanceSystem
}

// chooseAppearance forces a look and keeps it.
func (a *mobileApp) chooseAppearance(code string) {
	a.appearance.Set(code)
	a.cx.SetAppearance(appearanceOf(code))
	a.saveLook()
}

// cycleAppearance steps through the three looks.
func (a *mobileApp) cycleAppearance() {
	next := appearanceSystem
	switch a.appearance.GetUntracked() {
	case appearanceSystem:
		next = appearanceLight
	case appearanceLight:
		next = appearanceDark
	}
	a.chooseAppearance(next)
}

// chooseLanguage switches the interface's language and keeps it.
func (a *mobileApp) chooseLanguage(code string) {
	a.cx.SetLocale(apptext.Locale(code))
	lang := apptext.ResolveLanguage(code, a.cx.Env().Locale())
	apptext.SetLanguage(lang)
	a.language.Set(lang)
	a.saveLook()
}

// saveLook keeps the connection, the language, the look and the last
// project in remote.json.
func (a *mobileApp) saveLook() {
	saveMobileSaved(a.cx, mobileSaved{Server: a.server.GetUntracked(), Token: a.token.GetUntracked(),
		Recent: a.recent.GetUntracked(), Language: a.language.GetUntracked(), Appearance: a.appearance.GetUntracked(),
		Project: a.initProject.GetUntracked(), Sound: a.soundOn.GetUntracked(), SoundName: a.soundName.GetUntracked(), Notify: a.notifyOn.GetUntracked()})
}

// projectCollapsed says the project's sessions are folded in the rail.
func (a *mobileApp) projectCollapsed(path string) bool {
	for _, p := range a.railCollapsed.Get() {
		if p == path {
			return true
		}
	}
	return false
}

// toggleProject folds or unfolds one project's sessions.
func (a *mobileApp) toggleProject(path string) {
	a.railCollapsed.Update(func(list []string) []string {
		out := make([]string, 0, len(list)+1)
		found := false
		for _, p := range list {
			if p == path {
				found = true
				continue
			}
			out = append(out, p)
		}
		if !found {
			out = append(out, path)
		}
		return out
	})
}

// projectSheet is one project's operations, under the rail's row.
func (a *mobileApp) projectSheet() core.Node {
	return ui.Dialog{
		Open:         func() bool { return a.projectOpen.Get() != "" },
		OnOpenChange: func(open bool, _ base.Reason) { a.projectOpen.Set("") },
		Title:        apptext.T("项目"),
		TestID:       "mobile-project-sheet",
		Style:        core.Style{Width: core.Pct(100), MaxWidth: core.Pt(420)},
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			path := a.projectOpen.Get()
			name := a.projectName(path)
			rows := []core.Node{
				core.View{Style: core.Style{Padding: core.Symmetric(4, 8)}, Children: []core.Node{
					core.Text{Content: name, MaxLines: 2, EllipsizeMode: core.EllipsizeMiddle,
						Style: core.Style{FontSize: 14, FontWeight: ui.Semibold, LineHeight: 20}, StyleFunc: ui.Colored(colors.Text)},
					core.Text{Content: path, MaxLines: 2, EllipsizeMode: core.EllipsizeMiddle,
						Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
				}},
				a.sheetRow(lucide.GitBranch, apptext.T("查看 Git"), colors.Text, func() {
					a.projectOpen.Set("")
					a.openGit(path, name)
				}, "mobile-project-git"),
				a.sheetRow(lucide.FolderPlus, apptext.T("添加项目…"), colors.Text, func() {
					a.projectOpen.Set("")
					a.addPath.Set("")
					a.addOpen.Set(true)
				}, "mobile-add-project-row"),
				a.sheetRow(lucide.FolderMinus, apptext.T("移除项目…"), colors.Danger, func() {
					a.projectOpen.Set("")
					a.removePath.Set(path)
				}, "mobile-remove-project"),
			}
			return core.View{Style: core.Style{Gap: 2}, Children: rows}
		})},
	}
}
