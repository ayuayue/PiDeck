//go:build !js && !android && !ios

package workbench

// The window: a rail of projects and sessions, a bar of session tabs, the
// chat, and a drawer for the session's numbers and the project's files.

import (
	"path/filepath"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// railActions are the rail header's buttons.
func (a *app) railActions() core.Node {
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 2}, Children: []core.Node{
		hint("新建会话", ui.IconButton{Icon: lucide.SquarePen, Label: apptext.T("新建会话"), Size: 30, IconSize: 15, OnPress: a.railNewSession}),
		hint("添加工作区", ui.IconButton{Icon: lucide.FolderPlus, Label: apptext.T("添加工作区"), Size: 30, IconSize: 15, OnPress: func() { a.pickNative("workspace") }}),
		hint("命令面板", ui.IconButton{Icon: lucide.Command, Label: apptext.T("命令面板"), Size: 30, IconSize: 15, TestID: "rail-palette", OnPress: func() { a.palette.Set(true) }}),
	}}
}

// railNewSession starts a session where the rail points: a conversation in
// the chat column, an empty session in the selected project otherwise.
func (a *app) railNewSession() {
	if a.railTab.GetUntracked() == railTabChat {
		a.openChat()
		return
	}
	ws := a.activeWS.Get()
	if ws == "" {
		if list := a.projects(); len(list) > 0 {
			ws = projectWireKey(list[0])
		}
	}
	a.newSession(ws)
}

// rail is the app's left area: the ways in, then the three columns under
// a hairline, as PiDeck keeps them.
func (a *app) rail() core.Node {
	return core.View{Style: ui.FillRest, Children: []core.Node{
		core.View{Style: core.Style{Padding: core.Edges{Top: 12, Right: 12, Bottom: 8, Left: 12}, Gap: 8, FlexShrink: 0}, Children: []core.Node{
			a.brand(),
			core.View{Style: core.Style{Gap: 2}, Children: []core.Node{a.newSessionButton(), a.searchField(), a.railMore()}},
			a.railDivider(),
			a.railTabBar(),
		}},
		core.Scroll{TestID: "rail-content-scroll", Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Right: 12, Bottom: 14, Left: 12}}, Children: []core.Node{a.railTabContent()}},
		}},
	}}
}

// railDivider is the hairline between the ways in and the columns.
func (a *app) railDivider() core.Node {
	return core.View{Style: core.Style{Height: core.Pt(1), Margin: core.Symmetric(4, 0)}, StyleFunc: ui.Filled(ui.ColorsOf(a.cx).Line)}
}

// projects are the rail's projects: every workspace but the built-in chat,
// which has its own column.
func (a *app) projects() []*workspace {
	var out []*workspace
	for _, ws := range a.workspaces.Get() {
		if ws != nil && !ws.Chat {
			out = append(out, ws)
		}
	}
	return out
}

// projectTotal is how many projects the rail holds.
func (a *app) projectTotal() int { return len(a.projects()) }

// groupLabel is a quiet heading inside a project: 置顶, 今天, 更早. It is
// the sidebar's caption size, as PiDeck's groups are, and keeps enough air
// above it that a group starts a paragraph rather than a row.
func (a *app) groupLabel(text string) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return core.View{Style: core.Style{Padding: core.Edges{Top: 10, Right: 8, Bottom: 2, Left: 8}}, Children: []core.Node{
			core.Text{Content: apptext.T(text), Style: core.Style{FontSize: 11, FontWeight: ui.Medium}, StyleFunc: ui.Colored(colors.Faint)},
		}}
	})
}

// railHeader is a small section title with a count.
func (a *app) railHeader(title, count string) core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Edges{Top: 6, Right: 8, Bottom: 3, Left: 8}},
		Children: []core.Node{
			ui.Text(title, 11, ui.Semibold, colors.Faint),
			core.View{Style: core.Style{FlexGrow: 1}},
			ui.Text(count, 11, ui.Regular, colors.Faint),
		}}
}

// piSessionRow is one of pi's own sessions, with the folder it ran in.
func (a *app) piSessionRow(s *session) core.Node {
	colors := ui.ColorsOf(a.cx)
	selected := func() bool { return a.activeID.Get() == s.ID }
	row := base.ContextMenu{
		Trigger: core.View{
			OnPress: func(core.PressEvent) { a.clearSessionHover(); a.selectSession(s) },
			Role:    core.RoleButton, LabelFunc: func() string { return s.title.Get() },
			StyleFunc: func() core.Style {
				st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(32), Padding: core.Symmetric(0, 8),
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
						Style: core.Style{FontSize: 13.5, LineHeight: 19}, StyleFunc: ui.Colored(colors.Text)},
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
	return a.sessionHoverCard(func() *session { return s }, sessionHoverRail, core.PlaceRight, row)
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

// newSessionButton is the rail's main action: a quiet row, as PiDeck's is,
// rather than a filled button.
func (a *app) newSessionButton() core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{
		OnPress: func(core.PressEvent) { a.railNewSession() },
		Role:    core.RoleButton, Label: apptext.T("新建会话"), TestID: "rail-new-session",
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, Height: core.Pt(32), Padding: core.Symmetric(0, 8),
				CornerRadius: 7, Transition: viewkit.PressMotion,
				Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{
			ui.Icon(lucide.CirclePlus, 15, colors.Muted),
			core.Text{Content: apptext.T("新建会话"), Style: core.Style{FontSize: 13.5, LineHeight: 19, FontWeight: ui.Medium, FlexGrow: 1}, StyleFunc: ui.Colored(colors.Text)},
			core.Text{Content: modKey() + "N", Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
		},
	}
}

// searchField opens the session search palette, as the command palette
// opens: the row reads as a way in, with its key, rather than a field the
// rail filters with.
func (a *app) searchField() core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{
		OnPress: func(core.PressEvent) { a.openSearch() },
		Role:    core.RoleButton, Label: apptext.T("搜索会话"), TestID: "rail-search",
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, Height: core.Pt(32), Padding: core.Symmetric(0, 8),
				CornerRadius: 7, Transition: viewkit.PressMotion,
				Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{
			ui.Icon(lucide.Search, 15, colors.Muted),
			core.Text{Content: apptext.T("搜索会话"), Style: core.Style{FontSize: 13.5, LineHeight: 19, FlexGrow: 1}, StyleFunc: ui.Colored(colors.Muted)},
			core.Text{Content: modKey() + "F", Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
		},
	}
}
