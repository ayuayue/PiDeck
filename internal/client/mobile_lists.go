package client

// The rail's four ways in: search, agents, the desktop's cron tasks and its
// favorites. Each opens a sheet over the page, loads what the desktop
// knows, and takes the phone back to a session when that is what the user
// picked.

import (
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// sheetWidth is how wide the phone's sheets show on a tablet or a page.
const sheetWidth core.Points = 520

// openSearch shows the search sheet with an empty query.
func (a *mobileApp) openSearch() {
	a.openDrawer(false)
	a.query.Set("")
	a.hits.Set(nil)
	a.hitsQuery = ""
	a.searchOpen.Set(true)
}

// openAgents lists the ways of working a session can start with.
func (a *mobileApp) openAgents() {
	a.openDrawer(false)
	a.agentsOpen.Set(true)
	a.loadAgents()
}

// openTasks lists the desktop's cron tasks.
func (a *mobileApp) openTasks() {
	a.openDrawer(false)
	a.tasksOpen.Set(true)
	a.loadTasks()
}

// openFavorites lists what the desktop saved.
func (a *mobileApp) openFavorites() {
	a.openDrawer(false)
	a.favoritesOpen.Set(true)
	a.loadFavorites()
}

// loadAgents reads the desktop's agents.
func (a *mobileApp) loadAgents() {
	client := a.client
	if client == nil || a.agentsBusy.GetUntracked() {
		return
	}
	a.agentsBusy.Set(true)
	a.agentsErr.Set("")
	go func() {
		list, err := client.agents()
		a.cx.Post(func() {
			a.agentsBusy.Set(false)
			if err != nil {
				a.agentsErr.Set(remoteErrorText(err))
				return
			}
			a.agents.Set(list)
		})
	}()
}

// loadTasks reads the desktop's tasks.
func (a *mobileApp) loadTasks() {
	client := a.client
	if client == nil || a.tasksBusy.GetUntracked() {
		return
	}
	a.tasksBusy.Set(true)
	a.tasksErr.Set("")
	go func() {
		list, err := client.tasks()
		a.cx.Post(func() {
			a.tasksBusy.Set(false)
			if err != nil {
				a.tasksErr.Set(remoteErrorText(err))
				return
			}
			a.tasks.Set(list)
		})
	}()
}

// loadFavorites reads what the desktop saved.
func (a *mobileApp) loadFavorites() {
	client := a.client
	if client == nil || a.favoritesBusy.GetUntracked() {
		return
	}
	a.favoritesBusy.Set(true)
	a.favoritesErr.Set("")
	go func() {
		list, err := client.favorites()
		a.cx.Post(func() {
			a.favoritesBusy.Set(false)
			if err != nil {
				a.favoritesErr.Set(remoteErrorText(err))
				return
			}
			a.favorites.Set(list)
		})
	}()
}

// startAgent starts a session that works with an agent, on the project
// the new-session page has picked.
func (a *mobileApp) startAgent(agent remotewire.Agent) {
	client := a.client
	project := a.initProjectPath()
	if client == nil || a.creating.GetUntracked() {
		return
	}
	if project == "" {
		a.agentsErr.Set(apptext.T("电脑上还没有项目，先在抽屉里添加一个"))
		return
	}
	visit := a.sessionSeq
	a.creating.Set(true)
	a.agentsOpen.Set(false)
	go func() {
		id, title, err := client.createAgentSession(project, agent.ID)
		a.cx.Post(func() {
			if a.client != client {
				return
			}
			a.creating.Set(false)
			if visit != a.sessionSeq {
				return
			}
			if err != nil {
				a.agentsErr.Set(remoteErrorText(err))
				return
			}
			a.openSession(id, title)
			a.flash(apptext.T("已启用") + " " + agent.Name)
			a.refreshState()
		})
	}()
}

// setTaskEnabled switches one of the desktop's tasks on or off.
func (a *mobileApp) setTaskEnabled(id string, enabled bool) {
	client := a.client
	if client == nil || id == "" {
		return
	}
	if a.taskBusy.GetUntracked() != "" {
		return
	}
	a.taskBusy.Set(id)
	go func() {
		err := client.setTaskEnabled(id, enabled)
		a.cx.Post(func() {
			a.taskBusy.Set("")
			if err != nil {
				a.tasksErr.Set(remoteErrorText(err))
				return
			}
			a.loadTasks()
		})
	}()
}

// runTask starts one of the desktop's tasks now.
func (a *mobileApp) runTask(id string) {
	client := a.client
	if client == nil || id == "" || a.taskBusy.GetUntracked() != "" {
		return
	}
	a.taskBusy.Set(id)
	go func() {
		err := client.runTask(id)
		a.cx.Post(func() {
			a.taskBusy.Set("")
			if err != nil {
				a.tasksErr.Set(remoteErrorText(err))
				return
			}
			a.flash(apptext.T("已在电脑上开始运行"))
			a.loadTasks()
		})
	}()
}

// searchSheet searches titles and messages on the desktop.
func (a *mobileApp) searchSheet() core.Node {
	return ui.Dialog{
		Open:         func() bool { return a.searchOpen.Get() },
		OnOpenChange: func(open bool, _ base.Reason) { a.searchOpen.Set(open) },
		Title:        apptext.T("搜索会话"),
		TestID:       "mobile-search-sheet",
		Style:        core.Style{Width: core.Pct(100), MaxWidth: core.Pt(sheetWidth)},
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			query := strings.ToLower(strings.TrimSpace(a.query.Get()))
			var rows []core.Node
			if query != "" {
				for _, p := range a.state.Get().Projects {
					for _, s := range p.Sessions {
						if !strings.Contains(strings.ToLower(s.Title), query) {
							continue
						}
						rows = append(rows, a.searchSessionRow(cx, p.Name, s))
					}
				}
				rows = append(rows, a.hitRows(cx, query)...)
			}
			var body []core.Node
			body = append(body, core.Input{
				Value: a.query.Get, OnChange: func(v string) {
					a.query.Set(v)
					a.scheduleSearch()
				}, Placeholder: apptext.T("搜索会话标题和消息"), Label: apptext.T("搜索会话"), TestID: "mobile-search-input",
				Style: core.Style{Height: core.Pt(40), Padding: core.Symmetric(0, 11), FontSize: 14, Color: colors.Text(),
					Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 9,
					PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection},
			})
			switch {
			case len(rows) > 0:
				body = append(body, a.scrollStashFor("searchSheet:1").Bind(cx, core.Scroll{Style: core.Style{MaxHeight: core.Pt(420)}, Children: []core.Node{
					core.View{Style: core.Style{Gap: 1, Padding: core.Edges{Right: viewkit.PanelInset}}, Children: rows},
				}}))
			case query != "":
				body = append(body, core.View{Style: core.Style{Padding: core.All(28), AlignItems: core.AlignCenter, Gap: 8},
					Children: []core.Node{
						ui.Icon(lucide.SearchX, 26, colors.Faint),
						ui.Text(apptext.T("没有匹配的会话"), 13, ui.Medium, colors.Muted),
						ui.Text(apptext.T("换个词试试，或者新建一个会话。"), 11.5, ui.Regular, colors.Faint),
					}})
			default:
				body = append(body, core.View{Style: core.Style{Padding: core.All(24), AlignItems: core.AlignCenter, Gap: 6},
					Children: []core.Node{
						ui.Icon(lucide.Search, 24, colors.Faint),
						ui.Text(apptext.T("搜会话标题，也搜消息正文"), 12, ui.Regular, colors.Faint),
					}})
			}
			return core.View{Style: core.Style{Gap: 10}, Children: body}
		})},
		Footer: []core.Node{
			ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "mobile-search-close",
				OnPress: func() { a.searchOpen.Set(false) }},
		},
	}
}

// searchSessionRow is one title a search matched.
func (a *mobileApp) searchSessionRow(cx *core.Scope, project string, s remotewire.Session) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{OnPress: func(core.PressEvent) {
		a.searchOpen.Set(false)
		a.openSession(s.ID, s.Title)
	}, Role: core.RoleButton, Label: s.Title, TestID: "mobile-session",
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(44),
				Padding: core.Symmetric(0, 8), CornerRadius: 8, Transition: viewkit.PressMotion,
				Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{
			ui.Icon(lucide.MessageSquare, 13, colors.Faint),
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 0}, Children: []core.Node{
				core.Text{Content: s.Title, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 13}, StyleFunc: ui.Colored(colors.Text)},
				core.Text{Content: project, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
					Style: core.Style{FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
			}},
			ui.Icon(lucide.ChevronRight, 12, colors.Faint),
		}}
}

// agentsSheet lists the ways of working a session can start with.
func (a *mobileApp) agentsSheet() core.Node {
	return ui.Dialog{
		Open:         func() bool { return a.agentsOpen.Get() },
		OnOpenChange: func(open bool, _ base.Reason) { a.agentsOpen.Set(open) },
		Title:        apptext.T("智能体"),
		Description:  apptext.T("选一个工作方式，在项目里开一个新会话。"),
		TestID:       "mobile-agents-sheet",
		Style:        core.Style{Width: core.Pct(100), MaxWidth: core.Pt(sheetWidth)},
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			list := a.agents.Get()
			switch {
			case a.agentsErr.Get() != "":
				return core.View{Style: core.Style{Padding: core.All(20), AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
					ui.Icon(lucide.TriangleAlert, 22, colors.Danger),
					ui.Text(a.agentsErr.Get(), 12, ui.Regular, colors.Muted),
					ui.Button{Text: apptext.T("重试"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						TestID: "mobile-agents-retry", OnPress: a.loadAgents},
				}}
			case len(list) == 0 && a.agentsBusy.Get():
				return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Symmetric(12, 4)},
					Children: []core.Node{
						ui.Spinner{Size: 13, Label: apptext.T("正在读取智能体")},
						ui.Text(apptext.T("正在读取智能体…"), 12, ui.Regular, colors.Faint),
					}}
			case len(list) == 0:
				return core.View{Style: core.Style{Padding: core.All(24), AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					ui.Icon(lucide.Bot, 24, colors.Faint),
					ui.Text(apptext.T("电脑上还没有智能体"), 12, ui.Regular, colors.Muted),
				}}
			}
			rows := make([]core.Node, 0, len(list))
			for _, agent := range list {
				item := agent
				rows = append(rows, core.View{OnPress: func(core.PressEvent) { a.startAgent(item) },
					Role: core.RoleButton, Label: item.Name, TestID: "mobile-agent",
					StyleFunc: func() core.Style {
						return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10, Padding: core.Symmetric(8, 8),
							CornerRadius: 9, Transition: viewkit.PressMotion, Hover: &core.Style{Background: colors.Hover()},
							Active: &core.Style{Background: colors.Pressed()}}
					},
					Children: []core.Node{
						core.View{StyleFunc: func() core.Style {
							return core.Style{Width: core.Pt(30), Height: core.Pt(30), CornerRadius: 8, Background: colors.Inset(),
								AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, FlexShrink: 0}
						}, Children: []core.Node{ui.Icon(lucide.Bot, 15, colors.Muted)}},
						core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
							core.Text{Content: item.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
								Style: core.Style{FontSize: 13.5, FontWeight: ui.Medium}, StyleFunc: ui.Colored(colors.Text)},
							core.Show{When: func() bool { return item.Description != "" }, Then: func(*core.Scope) core.Node {
								return core.Text{Content: item.Description, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
									Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Muted)}
							}},
						}},
						core.Dynamic(func(*core.Scope) core.Node {
							if a.creating.Get() {
								return nil
							}
							return ui.Icon(lucide.ChevronRight, 12, colors.Faint)
						}),
					}})
			}
			return core.View{Style: core.Style{Gap: 1}, Children: rows}
		})},
	}
}

// tasksSheet lists the desktop's cron tasks with their next and last run.
func (a *mobileApp) tasksSheet() core.Node {
	return ui.Dialog{
		Open:         func() bool { return a.tasksOpen.Get() },
		OnOpenChange: func(open bool, _ base.Reason) { a.tasksOpen.Set(open) },
		Title:        apptext.T("定时任务"),
		Description:  apptext.T("到点在电脑上新建会话，把提示词发出去。"),
		TestID:       "mobile-tasks-sheet",
		Style:        core.Style{Width: core.Pct(100), MaxWidth: core.Pt(sheetWidth)},
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			list := a.tasks.Get()
			switch {
			case a.tasksErr.Get() != "":
				return core.View{Style: core.Style{Padding: core.All(20), AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
					ui.Icon(lucide.TriangleAlert, 22, colors.Danger),
					ui.Text(a.tasksErr.Get(), 12, ui.Regular, colors.Muted),
					ui.Button{Text: apptext.T("重试"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						TestID: "mobile-tasks-retry", OnPress: a.loadTasks},
				}}
			case len(list) == 0 && a.tasksBusy.Get():
				return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Symmetric(12, 4)},
					Children: []core.Node{
						ui.Spinner{Size: 13, Label: apptext.T("正在读取定时任务")},
						ui.Text(apptext.T("正在读取定时任务…"), 12, ui.Regular, colors.Faint),
					}}
			case len(list) == 0:
				return core.View{Style: core.Style{Padding: core.All(24), AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					ui.Icon(lucide.CalendarClock, 24, colors.Faint),
					ui.Text(apptext.T("电脑上还没有定时任务"), 12, ui.Regular, colors.Muted),
					ui.Text(apptext.T("在电脑端的命令面板里新建一个，手机上可以开关和手动跑一次。"), 11, ui.Regular, colors.Faint),
				}}
			}
			rows := make([]core.Node, 0, len(list))
			for _, task := range list {
				item := task
				rows = append(rows, a.taskRow(cx, item))
			}
			return a.scrollStashFor("tasksSheet:1").Bind(cx, core.Scroll{Style: core.Style{MaxHeight: core.Pt(460)}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 6, Padding: core.Edges{Right: viewkit.PanelInset}}, Children: rows},
			}})
		})},
	}
}

// taskRow is one task: its schedule and switch, and when unfolded what it
// sends and the two things the phone can do with it.
func (a *mobileApp) taskRow(cx *core.Scope, t remotewire.Task) core.Node {
	colors := ui.ColorsOf(cx)
	open := a.taskOpen.Get() == t.ID
	rows := []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
			core.View{OnPress: func(core.PressEvent) {
				if open {
					a.taskOpen.Set("")
				} else {
					a.taskOpen.Set(t.ID)
				}
			}, Role: core.RoleButton, Label: t.Name, TestID: "mobile-task",
				Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, FlexGrow: 1, FlexShrink: 1,
					MinWidth: core.Pt(0), MinHeight: core.Pt(42), Padding: core.Symmetric(0, 4), CornerRadius: 8},
				Children: []core.Node{
					ui.IconOf(func() *core.SVG {
						if open {
							return lucide.ChevronDown()
						}
						return lucide.ChevronRight()
					}, 12, colors.Faint),
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
						core.Text{Content: t.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{FontSize: 13.5, FontWeight: ui.Medium}, StyleFunc: ui.Colored(colors.Text)},
						core.Text{Content: taskScheduleLine(t), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
					}},
				}},
			ui.Switch{Checked: func() bool { return t.Enabled }, OnChange: func(on bool) { a.setTaskEnabled(t.ID, on) },
				Label: apptext.T("启用") + " " + t.Name, Size: ui.SizeSmall, TestID: "mobile-task-switch"},
		}},
	}
	if open {
		detail := []core.Node{
			core.Text{Content: taskNextLine(t), Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
			core.Show{When: func() bool { return t.LastStatus != "" }, Then: func(*core.Scope) core.Node {
				return ui.Text(apptext.T("上次")+"："+taskStatusText(t.LastStatus), 11, ui.Regular, colors.Muted)
			}},
			core.Show{When: func() bool { return strings.TrimSpace(t.Prompt) != "" }, Then: func(cx *core.Scope) core.Node {
				return core.View{StyleFunc: func() core.Style {
					return core.Style{Padding: core.All(9), CornerRadius: 8, Background: colors.Inset()}
				}, Children: []core.Node{core.Text{Content: t.Prompt, MaxLines: 8, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 11.5, LineHeight: 17}, StyleFunc: ui.Colored(colors.Text)}}}
			}},
			core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 8, Margin: core.Edges{Top: 2}}, Children: []core.Node{
				core.Dynamic(func(*core.Scope) core.Node {
					if a.taskBusy.Get() == t.ID {
						return ui.Spinner{Size: 13, Label: apptext.T("正在运行")}
					}
					return ui.Button{Text: apptext.T("运行一次"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						TestID: "mobile-task-run", OnPress: func() { a.runTask(t.ID) }}
				}),
				core.Show{When: func() bool { return t.SessionID != "" }, Then: func(*core.Scope) core.Node {
					return ui.Button{Text: apptext.T("打开上次的会话"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
						TestID: "mobile-task-session", OnPress: func() {
							a.tasksOpen.Set(false)
							a.openSession(t.SessionID, t.Name)
						}}
				}},
			}},
		}
		rows = append(rows, core.View{Style: core.Style{Gap: 7, Padding: core.Edges{Top: 2, Right: 6, Bottom: 8, Left: 24}},
			Children: detail})
	}
	return core.View{StyleFunc: func() core.Style {
		return core.Style{Gap: 2, Padding: core.Symmetric(2, 6), CornerRadius: 10, Background: colors.Surface(),
			BorderWidth: 1, BorderColor: colors.Line()}
	}, Children: rows}
}

// taskScheduleLine is a task's expression and when it fires next.
func taskScheduleLine(t remotewire.Task) string {
	line := t.Cron
	switch {
	case !t.Enabled:
		line += " · " + apptext.T("已暂停")
	case t.NextRunAt > 0:
		line += " · " + apptext.T("下次") + " " + time.UnixMilli(t.NextRunAt).Format("01-02 15:04")
	}
	return line
}

// taskNextLine says where it runs and what the desktop knows about it.
func taskNextLine(t remotewire.Task) string {
	parts := []string{apptext.T("电脑上的 cron 任务")}
	if t.Project != "" {
		parts = append(parts, t.Project)
	}
	if t.Backend == "acp" {
		parts = append(parts, "ACP")
	}
	return strings.Join(parts, " · ")
}

// taskStatusText names a run's outcome.
func taskStatusText(status string) string {
	switch status {
	case "running":
		return apptext.T("运行中")
	case "ok":
		return apptext.T("完成")
	case "failed":
		return apptext.T("失败")
	case "timeout":
		return apptext.T("超时")
	case "skipped":
		return apptext.T("跳过")
	case "cancelled":
		return apptext.T("已停止")
	case "interrupted":
		return apptext.T("已中断")
	}
	return status
}

// favoritesSheet lists the answers and sessions saved on the desktop.
func (a *mobileApp) favoritesSheet() core.Node {
	return ui.Dialog{
		Open:         func() bool { return a.favoritesOpen.Get() },
		OnOpenChange: func(open bool, _ base.Reason) { a.favoritesOpen.Set(open) },
		Title:        apptext.T("收藏"),
		Description:  apptext.T("电脑上存下的回复和会话。"),
		TestID:       "mobile-favorites-sheet",
		Style:        core.Style{Width: core.Pct(100), MaxWidth: core.Pt(sheetWidth)},
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			list := a.favorites.Get()
			switch {
			case a.favoritesErr.Get() != "":
				return core.View{Style: core.Style{Padding: core.All(20), AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
					ui.Icon(lucide.TriangleAlert, 22, colors.Danger),
					ui.Text(a.favoritesErr.Get(), 12, ui.Regular, colors.Muted),
					ui.Button{Text: apptext.T("重试"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						TestID: "mobile-favorites-retry", OnPress: a.loadFavorites},
				}}
			case len(list) == 0 && a.favoritesBusy.Get():
				return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Symmetric(12, 4)},
					Children: []core.Node{
						ui.Spinner{Size: 13, Label: apptext.T("正在读取收藏")},
						ui.Text(apptext.T("正在读取收藏…"), 12, ui.Regular, colors.Faint),
					}}
			case len(list) == 0:
				return core.View{Style: core.Style{Padding: core.All(24), AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					ui.Icon(lucide.Star, 24, colors.Faint),
					ui.Text(apptext.T("还没有收藏"), 12, ui.Regular, colors.Muted),
					ui.Text(apptext.T("在电脑上右键回复或会话就能存进来。"), 11, ui.Regular, colors.Faint),
				}}
			}
			rows := make([]core.Node, 0, len(list))
			for _, fav := range list {
				item := fav
				rows = append(rows, a.favoriteRow(cx, item))
			}
			return a.scrollStashFor("favoritesSheet:1").Bind(cx, core.Scroll{Style: core.Style{MaxHeight: core.Pt(460)}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 1, Padding: core.Edges{Right: viewkit.PanelInset}}, Children: rows},
			}})
		})},
	}
}

// favoriteRow is one saved answer or session.
func (a *mobileApp) favoriteRow(cx *core.Scope, f remotewire.Favorite) core.Node {
	colors := ui.ColorsOf(cx)
	reply := f.Kind == "reply"
	title := f.SessionTitle
	if title == "" {
		title = f.Prompt
	}
	if title == "" {
		title = apptext.T("收藏的回复")
	}
	snippet := strings.TrimSpace(f.Text)
	if reply && snippet == "" {
		snippet = f.Prompt
	}
	return core.View{OnPress: func(core.PressEvent) {
		if reply {
			a.favOpen.Set(f.ID)
			return
		}
		a.favoritesOpen.Set(false)
		a.openSession(f.SessionID, title)
	}, Role: core.RoleButton, Label: title, TestID: "mobile-favorite",
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignStart, Gap: 9, Padding: core.Symmetric(8, 8),
				CornerRadius: 9, Transition: viewkit.PressMotion, Hover: &core.Style{Background: colors.Hover()},
				Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{
			ui.IconOf(func() *core.SVG {
				if reply {
					return lucide.MessageSquare()
				}
				return lucide.MessageCircle()
			}, 14, colors.Faint),
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 2}, Children: []core.Node{
				core.Text{Content: title, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 13, FontWeight: ui.Medium}, StyleFunc: ui.Colored(colors.Text)},
				core.Show{When: func() bool { return strings.TrimSpace(snippet) != "" }, Then: func(*core.Scope) core.Node {
					return core.Text{Content: snippet, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Muted)}
				}},
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					ui.Text(mobileWhen(f.CreatedAt), 9.5, ui.Regular, colors.Faint),
					core.Show{When: func() bool { return f.Project != "" }, Then: func(*core.Scope) core.Node {
						return core.Text{Content: f.Project, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)}
					}},
				}},
			}},
		}}
}

// favoriteTextSheet shows one saved answer in full, to read or copy.
func (a *mobileApp) favoriteTextSheet() core.Node {
	return ui.Dialog{
		Open: func() bool { return a.favOpen.Get() != "" },
		OnOpenChange: func(open bool, _ base.Reason) {
			if !open {
				a.favOpen.Set("")
			}
		},
		Title:  apptext.T("收藏的回复"),
		TestID: "mobile-favorite-sheet",
		Style:  core.Style{Width: core.Pct(100), MaxWidth: core.Pt(sheetWidth)},
		Children: []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			var found *remotewire.Favorite
			for _, f := range a.favorites.Get() {
				if f.ID == a.favOpen.Get() {
					cp := f
					found = &cp
					break
				}
			}
			if found == nil {
				return nil
			}
			entry := *found
			var head []core.Node
			if entry.Prompt != "" {
				head = append(head, core.View{Style: core.Style{Gap: 2}, Children: []core.Node{
					ui.Text(apptext.T("提问"), 10, ui.Medium, colors.Faint),
					core.Text{Content: entry.Prompt, MaxLines: 3, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FontSize: 12, LineHeight: 17}, StyleFunc: ui.Colored(colors.Muted)},
				}})
			}
			return core.View{Style: core.Style{Gap: 10}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 8}, Children: head},
				a.scrollStashFor("favoriteTextSheet:1").Bind(cx, core.Scroll{Style: core.Style{MaxHeight: core.Pt(360)}, Children: []core.Node{
					core.View{Selectable: true, StyleFunc: func() core.Style {
						return core.Style{Padding: core.Edges{Top: 10, Right: viewkit.PanelInset, Bottom: 10, Left: 10}, CornerRadius: 9, Background: colors.Inset()}
					}, Children: []core.Node{core.Text{Content: entry.Text, Style: core.Style{FontSize: 12, LineHeight: 18},
						StyleFunc: ui.Colored(colors.Text)}}},
				}}),
			}}
		})},
		Footer: []core.Node{
			ui.Button{Text: apptext.T("复制"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "mobile-favorite-copy",
				OnPress: func() {
					for _, f := range a.favorites.GetUntracked() {
						if f.ID == a.favOpen.GetUntracked() {
							a.cx.SetClipboard(f.Text)
							a.flash("已复制")
							break
						}
					}
				}},
			ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.favOpen.Set("") }},
		},
	}
}
