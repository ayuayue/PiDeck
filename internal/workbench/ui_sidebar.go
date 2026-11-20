//go:build !js && !android && !ios

package workbench

// The window: a rail of projects and sessions, a bar of session tabs, the
// chat, and a drawer for the session's numbers and the project's files.

import (
	"fmt"
	"path/filepath"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// railActions are the rail header's buttons.
func (a *app) railActions() core.Node {
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 2}, Children: []core.Node{
		hint("新建会话", ui.IconButton{Icon: lucide.SquarePen, Label: apptext.T("新建会话"), Size: 30, IconSize: 15, OnPress: func() {
			ws := a.activeWS.Get()
			if ws == "" {
				if list := a.workspaces.Get(); len(list) > 0 {
					ws = list[0].Path
				}
			}
			a.newSession(ws)
		}}),
		hint("添加工作区", ui.IconButton{Icon: lucide.FolderPlus, Label: apptext.T("添加工作区"), Size: 30, IconSize: 15, OnPress: func() { a.pickNative("workspace") }}),
		hint("命令面板", ui.IconButton{Icon: lucide.Command, Label: apptext.T("命令面板"), Size: 30, IconSize: 15, TestID: "rail-palette", OnPress: func() { a.palette.Set(true) }}),
	}}
}

// rail is the projects and sessions list: what is pinned, the projects,
// and pi's own sessions when browsing them is on.
func (a *app) rail() core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.Scroll{Style: ui.FillRest, Children: []core.Node{
		core.View{Style: core.Style{Padding: core.Edges{Top: 10, Right: 10, Bottom: 12, Left: 10}, Gap: 10}, Children: []core.Node{
			a.brand(),
			a.newSessionButton(),
			a.searchField(),
			a.railShortcuts(),
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Edges{Top: 4, Right: 8, Left: 8}},
				Children: []core.Node{
					core.Text{Content: apptext.T("项目"), Style: core.Style{FontSize: 10, FontWeight: ui.Semibold, LetterSpacing: 0.6},
						StyleFunc: ui.Colored(colors.Faint)},
					core.View{Style: core.Style{FlexGrow: 1}},
					core.Text{ContentFunc: func() string { return fmt.Sprint(len(a.workspaces.Get())) },
						Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
					core.View{OnPress: func(core.PressEvent) { a.pickNative("workspace") }, Role: core.RoleButton, Label: apptext.T("添加项目"),
						TestID: "add-project",
						StyleFunc: func() core.Style {
							return core.Style{Direction: core.Row, Padding: core.Symmetric(1, 4), CornerRadius: 4,
								Hover: &core.Style{Background: colors.Hover()}}
						}, Children: []core.Node{ui.Icon(lucide.Plus, 11, colors.Muted)}},
					core.View{OnPress: func(core.PressEvent) { a.openTargetDialog(targetWSL) }, Role: core.RoleButton, Label: apptext.T("添加 WSL 工作区"),
						StyleFunc: func() core.Style {
							return core.Style{Direction: core.Row, Padding: core.Symmetric(1, 4), CornerRadius: 4,
								Hover: &core.Style{Background: colors.Hover()}}
						}, Children: []core.Node{ui.Text("WSL", 9.5, ui.Medium, colors.Faint)}},
					core.View{OnPress: func(core.PressEvent) { a.openTargetDialog(targetSSH) }, Role: core.RoleButton, Label: apptext.T("添加 SSH 工作区"),
						StyleFunc: func() core.Style {
							return core.Style{Direction: core.Row, Padding: core.Symmetric(1, 4), CornerRadius: 4,
								Hover: &core.Style{Background: colors.Hover()}}
						}, Children: []core.Node{ui.Text("SSH", 9.5, ui.Medium, colors.Faint)}},
				}},
			a.projectList(),
		}},
	}}
}

// groupLabel is a quiet heading inside a project: 置顶, 今天, 更早.
func (a *app) groupLabel(text string) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return core.View{Style: core.Style{Padding: core.Edges{Top: 6, Right: 8, Bottom: 1, Left: 8}}, Children: []core.Node{
			core.Text{Content: apptext.T(text), Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9, LetterSpacing: 0.5},
				StyleFunc: ui.Colored(colors.Faint)},
		}}
	})
}

// railHeader is a small section title with a count.
func (a *app) railHeader(title, count string) core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Edges{Top: 4, Right: 8, Bottom: 2, Left: 8}},
		Children: []core.Node{
			ui.Text(title, 10, ui.Semibold, colors.Faint),
			core.View{Style: core.Style{FlexGrow: 1}},
			ui.Text(count, 10, ui.Regular, colors.Faint),
		}}
}

// piSessionRow is one of pi's own sessions, with the folder it ran in.
func (a *app) piSessionRow(s *session) core.Node {
	colors := ui.ColorsOf(a.cx)
	selected := func() bool { return a.activeID.Get() == s.ID }
	return base.ContextMenu{
		Trigger: core.View{
			OnPress: func(core.PressEvent) { a.selectSession(s) },
			Role:    core.RoleButton, LabelFunc: func() string { return s.title.Get() },
			StyleFunc: func() core.Style {
				st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Height: core.Pt(30), Padding: core.Symmetric(0, 8),
					CornerRadius: 7, Transition: viewkit.PressMotion,
					Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
				if selected() {
					st.Background = colors.Pressed()
				}
				return st
			},
			Children: []core.Node{
				ui.Icon(lucide.Clock, 12, colors.Faint),
				core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
					core.Text{ContentFunc: func() string { return s.title.Get() }, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FontSize: 12, LineHeight: 16}, StyleFunc: ui.Colored(colors.Text)},
					core.Text{ContentFunc: func() string { return shorten(filepath.Base(s.WS), 34) }, MaxLines: 1,
						Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9, LineHeight: 12}, StyleFunc: ui.Colored(colors.Faint)},
				}},
			},
		},
		Children:   a.sessionMenuItems(func() *session { return s }),
		PopupStyle: core.Style{MinWidth: core.Pt(200)},
		PopupStyleFunc: func() core.Style {
			return a.menuCard(a.cx)
		},
	}
}

// piStatus is what the brand says about pi, and the color of its dot.
func (a *app) piStatus(colors ui.Colors) (string, core.Color) {
	info := a.env.Get()
	switch {
	case info.Probing:
		return apptext.T("检测 pi…"), colors.Muted()
	case info.PiError != "" || info.PiPath == "":
		return apptext.T("未找到 pi"), colors.Danger()
	case info.PiVersion != "":
		return "pi " + shorten(info.PiVersion, 20), colors.Up()
	default:
		return apptext.T("pi 就绪"), colors.Up()
	}
}

// newSessionButton is the rail's main action.
func (a *app) newSessionButton() core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{
		OnPress: func(core.PressEvent) {
			ws := a.activeWS.Get()
			if ws == "" {
				if list := a.workspaces.Get(); len(list) > 0 {
					ws = list[0].Path
				}
			}
			a.newSession(ws)
		},
		Role: core.RoleButton, Label: apptext.T("新建会话"), TestID: "rail-new-session",
		StyleFunc: func() core.Style {
			p := colors.Now()
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(34), Padding: core.Symmetric(0, 10),
				CornerRadius: ui.RadiusControl, Background: colors.Light(), Color: colors.OnLight(), Transition: viewkit.PressMotion,
				Hover: &core.Style{Background: p.AccentHover}, Active: &core.Style{Background: p.AccentPressed}}
		},
		Children: []core.Node{
			ui.Icon(lucide.Plus, 14, colors.OnLight),
			core.Text{Content: apptext.T("新建会话"), Style: core.Style{FontSize: 13, FontWeight: ui.Semibold, FlexGrow: 1}, StyleFunc: ui.Colored(colors.OnLight)},
			core.Text{Content: modKey() + "N", Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10, Opacity: core.Alpha(0.55)}, StyleFunc: ui.Colored(colors.OnLight)},
		},
	}
}

// railShortcuts are the ways in under 新建会话: the agent manager, the
// scheduled tasks and the favorites, one to a row as the phone's rail and
// PiDeck keep them.
func (a *app) railShortcuts() core.Node {
	colors := ui.ColorsOf(a.cx)
	// entry is one way in; pane names the split pane it opens, so the row
	// shows while that pane fills the work area.
	entry := func(icon func() *core.SVG, label, id, pane string, on func()) core.Node {
		return core.View{
			OnPress: func(core.PressEvent) { on() },
			Role:    core.RoleButton, Label: apptext.T(label), TestID: id,
			StyleFunc: func() core.Style {
				st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, Height: core.Pt(30), Padding: core.Symmetric(0, 8),
					CornerRadius: 7, Transition: viewkit.PressMotion,
					Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
				if a.paneVisible() && a.activePane.Get() == pane {
					st.Background = colors.Pressed()
				}
				return st
			},
			Children: []core.Node{
				ui.Icon(icon, 13.5, colors.Muted),
				ui.Text(apptext.T(label), 12.5, ui.Regular, colors.Text),
			},
		}
	}
	return core.View{Style: core.Style{Gap: 1}, Children: []core.Node{
		a.activityShortcut(),
		entry(lucide.Bot, "智能体", "rail-agents", paneAgents, func() { a.openAgentManager() }),
		entry(lucide.CalendarClock, "定时任务", "rail-tasks", paneTasks, func() { a.openTaskDialog() }),
		entry(lucide.Star, "收藏夹", "rail-favorites", paneFavorites, func() { a.openFavorites() }),
		entry(lucide.BookOpen, "草稿本", "rail-drafts", paneDrafts, func() { a.openDrafts(false) }),
	}}
}

// searchField filters the rail.
func (a *app) searchField() core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{StyleFunc: func() core.Style {
		return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Height: core.Pt(30), Padding: core.Symmetric(0, 9),
			CornerRadius: ui.RadiusControl, Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder()}
	}, Children: []core.Node{
		ui.Icon(lucide.Search, 13, colors.Faint),
		core.Input{
			Value: a.filter.Get, OnChange: a.filter.Set, Placeholder: apptext.T("搜索会话"), Label: apptext.T("搜索会话"), TestID: "rail-search",
			Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0), FontSize: 12.5, LineHeight: 18, Color: colors.Text()},
			StyleFunc: func() core.Style {
				return core.Style{PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
			},
		},
	}}
}
