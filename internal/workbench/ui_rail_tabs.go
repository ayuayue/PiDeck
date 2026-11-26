//go:build !js && !android && !ios

package workbench

// The rail's three columns: the started sessions at work, the built-in
// chat, and the projects. One shows at a time, the width the rail always
// had, and the header above them is shared so a column starts at the same
// place whichever is picked.

import (
	"fmt"
	"slices"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// The rail's columns, by id.
const (
	railTabActivity = "activity"
	railTabChat     = "chat"
	railTabProjects = "projects"
)

// openRailTab shows a column and, for the chat, makes its folder first.
func (a *app) openRailTab(id string) {
	a.railTab.Set(id)
	if id == railTabChat {
		a.ensureChatWorkspace()
	}
	if !a.sidebar.GetUntracked() {
		a.sidebar.Set(true)
	}
}

// railMore is 更多: the pages that are not a column, folded away until
// they are asked for, as PiDeck keeps them.
func (a *app) railMore() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		open := a.railMoreOpen.Get()
		var children []core.Node
		children = append(children, core.View{
			OnPress: func(core.PressEvent) { a.railMoreOpen.Update(func(v bool) bool { return !v }) },
			Role:    core.RoleButton, Label: apptext.T("更多"), TestID: "rail-more",
			Expanded: func() bool { return open },
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, Height: core.Pt(32), Padding: core.Symmetric(0, 8),
					CornerRadius: 7, Transition: viewkit.PressMotion,
					Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
			},
			Children: []core.Node{
				ui.IconOf(func() *core.SVG {
					if open {
						return lucide.ChevronDown()
					}
					return lucide.ChevronRight()
				}, 15, colors.Faint),
				core.Text{Content: apptext.T("更多"), Style: core.Style{FontSize: 13.5, LineHeight: 19, FontWeight: ui.Medium}, StyleFunc: ui.Colored(colors.Text)},
			},
		})
		if !open {
			return core.View{Children: children}
		}
		entry := func(icon func() *core.SVG, label, id, pane string, on func()) core.Node {
			return core.View{
				OnPress: func(core.PressEvent) { on() },
				Role:    core.RoleButton, Label: apptext.T(label), TestID: id,
				StyleFunc: func() core.Style {
					st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, Height: core.Pt(32),
						Padding: core.Edges{Left: 32, Right: 8}, CornerRadius: 7, Transition: viewkit.PressMotion,
						Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
					if a.paneVisible() && a.activePane.Get() == pane {
						st.Background = colors.Pressed()
					}
					return st
				},
				Children: []core.Node{
					ui.Icon(icon, 14, colors.Muted),
					ui.Text(apptext.T(label), 13, ui.Regular, colors.Text),
				},
			}
		}
		children = append(children,
			entry(lucide.GitPullRequest, "评审", "rail-review", paneReview, func() { a.openReviewPane() }),
			entry(lucide.Bot, "智能体", "rail-agents", paneAgents, func() { a.openAgentManager() }),
			entry(lucide.CalendarClock, "定时任务", "rail-tasks", paneTasks, func() { a.openTaskDialog() }),
			entry(lucide.Star, "收藏夹", "rail-favorites", paneFavorites, func() { a.openFavorites() }))
		return core.View{Style: core.Style{Gap: 1}, Children: children}
	})
}

// railTabBar is the three columns' switch: no frame of its own, the rail's
// background behind it, and the picked column in a soft pill.
func (a *app) railTabBar() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		on := func(id string) bool { return a.railTab.Get() == id }
		labelColor := func(id string) core.Style {
			if on(id) {
				return core.Style{Color: colors.Text()}
			}
			return core.Style{Color: colors.Muted()}
		}
		tab := func(id, label string, icon func() *core.SVG) core.Node {
			return base.ContextMenu{Trigger: core.View{
				OnPress: func(core.PressEvent) { a.openRailTab(id) },
				Role:    core.RoleTab, Label: apptext.T(label), TestID: "rail-tab-" + id,
				Selected: func() bool { return on(id) },
				StyleFunc: func() core.Style {
					st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 6,
						Height: core.Pt(30), FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), CornerRadius: 15,
						Transition: viewkit.PressMotion, Hover: &core.Style{Background: colors.Hover()},
						Active: &core.Style{Background: colors.Pressed()}}
					if on(id) {
						st.Background = colors.Pressed()
					}
					return st
				},
				Children: []core.Node{
					ui.IconOf(icon, 13.5, func() core.Color {
						if on(id) {
							return colors.Text()
						}
						return colors.Muted()
					}),
					core.Text{Content: apptext.T(label), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style:     core.Style{FontSize: 12, FontWeight: ui.Medium, FlexShrink: 1, MinWidth: core.Pt(0)},
						StyleFunc: func() core.Style { return labelColor(id) }},
				},
			}, Children: a.railTabMenuItems(id), PopupStyle: a.menuPopup(cx),
				PopupStyleFunc: func() core.Style { return a.menuCard(cx) }}
		}
		tabStyle := core.Style{FlexGrow: 1, FlexShrink: 1, FlexBasis: core.Pt(0), MinWidth: core.Pt(0)}
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 2}, Children: []core.Node{
			core.View{Style: tabStyle, Children: []core.Node{tab(railTabActivity, "活动", lucide.Activity)}},
			core.View{Style: tabStyle, Children: []core.Node{tab(railTabChat, "聊天", lucide.MessageCircle)}},
			core.View{Style: tabStyle, Children: []core.Node{tab(railTabProjects, "项目", lucide.Folder)}},
		}}
	})
}

// railTabContent is the column the rail shows.
func (a *app) railTabContent() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		switch a.railTab.Get() {
		case railTabActivity:
			return a.railActivity()
		case railTabChat:
			return a.railChats()
		default:
			return a.projectList()
		}
	})
}

// railActivity lists every started session that is running or waiting for
// an answer, from all projects: the work the app is doing now.
func (a *app) railActivity() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		items := a.activityItems()
		if query := strings.ToLower(strings.TrimSpace(a.filter.Get())); query != "" {
			items = slices.DeleteFunc(items, func(item activityItem) bool {
				return !containsQuery(item.session.title.Get(), query)
			})
		}
		waiting, running := a.activityGroups()
		header := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Wrap: core.Wrap, Gap: 8,
			Padding: core.Edges{Top: 2, Right: 8, Bottom: 2, Left: 8}}, Children: []core.Node{
			core.Text{Content: apptext.T("需要确认 · %d", waiting), Style: core.Style{FontSize: 11.5, FontWeight: ui.Medium},
				StyleFunc: ui.Colored(colors.Warn)},
			core.Text{Content: apptext.T("正在运行 · %d", running), Style: core.Style{FontSize: 11.5}, StyleFunc: ui.Colored(colors.Muted)},
		}}
		if len(items) == 0 {
			text := apptext.T("目前没有需要处理的对话")
			if a.filter.Get() != "" {
				text = apptext.T("没有匹配的会话")
			}
			return core.View{Style: core.Style{Gap: 6, Padding: core.Symmetric(18, 10), AlignItems: core.AlignCenter}, Children: []core.Node{
				header,
				ui.Icon(lucide.CircleCheck, 20, colors.Faint),
				core.Text{Content: text, Style: core.Style{FontSize: 12.5, TextAlign: core.TextAlignCenter}, StyleFunc: ui.Colored(colors.Muted)},
			}}
		}
		rows := make([]core.Node, 0, len(items)+1)
		rows = append(rows, header)
		for _, item := range items {
			rows = append(rows, a.activityRow(item, colors))
		}
		return core.View{TestID: "activity-list", Style: core.Style{Gap: 2}, Children: rows}
	})
}

// railChats lists the built-in chat's sessions: conversations that belong
// to no project. Its heading is the column's own, as the project column's
// is, so the chats start with the block that belongs to the list.
func (a *app) railChats() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		ws := a.chatWorkspace()
		var pinned, rest []*session
		if ws != nil {
			// A chat session of pi's own, made outside the app, shows too.
			a.scanProject(ws)
			pinned, rest = a.projectSessions(ws)
		}
		query := strings.ToLower(strings.TrimSpace(a.filter.Get()))
		tree := a.projectTree(pinned, rest, query)
		var rows []core.Node
		if query != "" {
			// A search keeps each match under the sessions above it.
			if len(tree.visible) > 0 {
				rows = a.sessionRows(append(append([]*session{}, pinned...), rest...), tree)
			}
		} else {
			if len(pinned) > 0 {
				rows = append(rows, a.sessionRows(pinned, tree)...)
			}
			if len(rest) > 0 {
				rows = append(rows, a.sessionRows(rest, tree)...)
			}
		}
		children := []core.Node{a.chatHeader(ws)}
		if len(rows) > 0 {
			children = append(children, core.View{Style: core.Style{Gap: 1}, Children: rows})
		} else {
			text := apptext.T("还没有对话")
			if query != "" {
				text = apptext.T("没有匹配的会话")
			}
			children = append(children, core.Text{Content: text,
				Style: core.Style{FontSize: 12, Padding: core.Edges{Left: 8, Top: 6}}, StyleFunc: ui.Colored(colors.Faint)})
		}
		return core.View{Style: core.Style{Gap: 2}, Children: children}
	})
}

// chatHeader is the chat column's heading: how many chats there are, the
// way to start one, and the list's own actions. It mirrors the project
// column's heading so both columns begin the same way.
func (a *app) chatHeader(ws *workspace) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		total := 0
		if ws != nil {
			total = projectSessionTotal(ws)
		}
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6,
			Padding: core.Edges{Top: 4, Right: 4, Bottom: 2, Left: 8}}, Children: []core.Node{
			ui.Text(apptext.T("聊天"), 11, ui.Semibold, colors.Faint),
			core.View{Style: core.Style{FlexGrow: 1}},
			core.Text{Content: fmt.Sprint(total), TestID: "chat-total",
				Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11}, StyleFunc: ui.Colored(colors.Faint)},
			hint("新对话", ui.IconButton{Icon: lucide.Plus, Label: apptext.T("新对话"), Size: 22, IconSize: 12,
				Tint: func() core.Color { return colors.Faint() }, TestID: "rail-new-chat", OnPress: func() { a.openChat() }}),
			a.chatHeaderMenu(),
		}}
	})
}

// chatHeaderMenu is the chat column's own actions: starting a chat, reading
// its folder again, and the list's order and archive.
func (a *app) chatHeaderMenu() core.Node {
	colors := ui.ColorsOf(a.cx)
	return ui.Menu{
		Open:         func() bool { return a.railMenuOpen.Get() == railTabChat },
		OnOpenChange: func(open bool, _ base.Reason) { a.setRailMenuOpen(railTabChat, open) },
		Placement:    core.PlaceBottom, Align: core.AlignEnd,
		Trigger: ui.Button{Icon: lucide.Ellipsis, Label: apptext.T("聊天操作"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
			Side: 22, IconSize: 12, Tint: func() core.Color { return colors.Faint() }},
		TestID:   "chat-header-menu",
		Children: a.chatHeaderMenuItems(),
	}
}
