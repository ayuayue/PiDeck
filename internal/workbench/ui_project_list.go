//go:build !js && !android && !ios

package workbench

// The rail's project column: its heading, the projects grouped as the user
// sorted them, and each project's sessions when it is open.

import (
	"fmt"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// projectList is the project column: its heading, then the workspace tree
// with the pinned projects first and the named groups after, one project
// told from the next by a hairline.
func (a *app) projectList() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		_ = a.projectsRev.Get()
		// The groups are built from a copy of the projects, read untracked,
		// so the list has to watch the projects themselves: adding or
		// removing one changes nothing the revision counts.
		_ = a.workspaces.Get()
		groups := a.projectGroups()
		out := []core.Node{a.projectHeader()}
		showHeaders := len(groups) > 1 || (len(groups) == 1 && (groups[0].Named || groups[0].Name != "未分组"))
		first := true
		for _, g := range groups {
			// A group's name belongs to the project under it, so the line
			// above the group keeps the name off the last project's rows.
			var head []core.Node
			if showHeaders {
				head = append(head, a.projectGroupHeading(g))
			}
			for _, w := range g.Projects {
				ws := w
				if !first {
					out = append(out, a.projectDivider())
				}
				first = false
				out = append(out, head...)
				head = nil
				out = append(out, a.workspaceBlock(func() *workspace { return ws }))
			}
		}
		return core.View{Style: core.Style{Gap: 2}, Children: out}
	})
}

// projectDivider is the hairline between two projects. An open project's
// sessions end above it, so where one project stops and the next starts
// reads at a glance instead of only from the folder glyphs.
func (a *app) projectDivider() core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{TestID: "project-divider",
		Style:     core.Style{Height: core.Pt(1), Margin: core.Edges{Top: 5, Right: 8, Bottom: 5, Left: 8}},
		StyleFunc: ui.Filled(colors.Border)}
}

// projectHeader is the column's heading: how many projects there are, and
// the way to add one.
func (a *app) projectHeader() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6,
			Padding: core.Edges{Top: 4, Right: 4, Bottom: 2, Left: 8}}, Children: []core.Node{
			ui.Text(apptext.T("项目"), viewkit.PanelCaptionSize, ui.Medium, colors.Faint),
			core.View{Style: core.Style{FlexGrow: 1}},
			core.Text{ContentFunc: func() string { return fmt.Sprint(a.projectTotal()) }, TestID: "project-total",
				Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11}, StyleFunc: ui.Colored(colors.Faint)},
			a.addProjectMenu(cx),
			a.projectHeaderMenu(),
		}}
	})
}

// projectHeaderMenu is the project column's own actions: what is about the
// list rather than one project, kept beside its count and its plus.
func (a *app) projectHeaderMenu() core.Node {
	colors := ui.ColorsOf(a.cx)
	return ui.Menu{
		Open:         func() bool { return a.railMenuOpen.Get() == railTabProjects },
		OnOpenChange: func(open bool, _ base.Reason) { a.setRailMenuOpen(railTabProjects, open) },
		Placement:    core.PlaceBottom, Align: core.AlignEnd,
		Trigger: ui.Button{Icon: lucide.Ellipsis, Label: apptext.T("项目操作"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
			Side: 22, IconSize: 12, Tint: func() core.Color { return colors.Faint() }},
		TestID:   "project-header-menu",
		Children: a.projectHeaderMenuItems(),
	}
}

// setRailMenuOpen opens or closes one column's header menu: one at a time,
// so opening the other column's closes it.
func (a *app) setRailMenuOpen(column string, open bool) {
	if open {
		a.clearSessionHover()
		a.railMenuOpen.Set(column)
		return
	}
	if a.railMenuOpen.GetUntracked() == column {
		a.railMenuOpen.Set("")
	}
}

// addProjectMenu adds a local or remote project, or groups several folders.
func (a *app) addProjectMenu(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	groupOpen := core.NewSignal(cx, false)
	menu := ui.Menu{
		Open: a.addProjectOpen.Get, OnOpenChange: func(open bool, _ base.Reason) {
			if open {
				a.clearSessionHover()
			}
			a.addProjectOpen.Set(open)
		},
		Placement: core.PlaceBottom, Align: core.AlignEnd,
		Trigger: ui.Button{Icon: lucide.Plus, Label: apptext.T("添加项目"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
			Side: 22, IconSize: 12, Tint: func() core.Color { return colors.Faint() }},
		TestID: "add-project",
		Children: []core.Node{
			ui.MenuItem{Text: apptext.T("本地目录…"), Icon: lucide.FolderPlus, TestID: "add-project-local",
				OnSelect: func() { a.pickNative("workspace") }},
			ui.MenuItem{Text: apptext.T("SSH 主机上的目录…"), Icon: lucide.Server, TestID: "add-project-ssh",
				OnSelect: func() { a.openTargetDialog(targetSSH) }},
			ui.MenuItem{Text: apptext.T("WSL 里的目录…"), Icon: lucide.Terminal, TestID: "add-project-wsl",
				OnSelect: func() { a.openTargetDialog(targetWSL) }},
			ui.MenuItem{Text: apptext.T("新建分组项目…"), Icon: lucide.FolderPlus, TestID: "add-project-group",
				OnSelect: func() { groupOpen.Set(true) }},
		},
	}
	return core.View{Children: []core.Node{menu, a.projectGroupCreateDialog(groupOpen)}}
}

// workspaceBlock is one project and, when open, its sessions.
func (a *app) workspaceBlock(w func() *workspace) core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{Style: core.Style{Gap: 2}, Children: []core.Node{
		base.ContextMenu{
			Trigger: core.View{
				OnPress: func(core.PressEvent) {
					a.animateNextLayout()
					// The project the rail points at is also where a new
					// session starts, so a click selects as well as opens.
					a.activeWS.Set(projectWireKey(w()))
					w().Expanded.Update(func(v bool) bool { return !v })
				},
				Role: core.RoleButton, LabelFunc: func() string { return w().label() }, TestID: "project-row",
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(32), Padding: core.Symmetric(0, 8),
						CornerRadius: ui.RadiusControl, Transition: viewkit.PressMotion,
						Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
				},
				Children: []core.Node{
					ui.IconOf(func() *core.SVG {
						if w().Expanded.Get() {
							return lucide.ChevronDown()
						}
						return lucide.ChevronRight()
					}, 12, colors.Faint),
					ui.IconOf(func() *core.SVG {
						if w().Chat {
							return lucide.MessageCircle()
						}
						if w().Expanded.Get() {
							return lucide.FolderOpen()
						}
						return lucide.Folder()
					}, 14, colors.Muted),
					core.Text{ContentFunc: func() string { return w().label() }, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: viewkit.PanelTextSize, LineHeight: viewkit.PanelLineHeight, FontWeight: ui.Medium},
						StyleFunc: ui.Colored(colors.Text)},
					core.Show{When: func() bool { return w().Target.remote() }, Then: func(*core.Scope) core.Node {
						return core.View{StyleFunc: func() core.Style {
							return core.Style{Padding: core.Symmetric(0, 4), CornerRadius: 3, Background: colors.Inset()}
						}, Children: []core.Node{
							ui.Text(w().Target.shortLabel(), 8.5, ui.Medium, colors.Muted),
						}}
					}},
					a.projectCount(w()),
					a.projectNewSessionButton(w),
					// Both actions stay on the row: a button that only appears
					// on hover moves the one beside it as the pointer arrives.
					a.projectMoreMenu(w),
				}},
			Children:   a.projectMenuItems(w),
			PopupStyle: core.Style{MinWidth: core.Pt(196)},
			PopupStyleFunc: func() core.Style {
				return a.menuCard(a.cx)
			},
		},
		core.Show{When: func() bool { return w().Expanded.Get() || a.filter.Get() != "" }, Then: func(cx *core.Scope) core.Node {
			return core.Dynamic(func(cx *core.Scope) core.Node {
				ws := w()
				_ = a.archiveRev.Get()
				// A project reads its own pi history the first time it is
				// opened, not every project's at startup.
				a.scanProject(ws)
				pinned, rest := a.projectSessions(ws)
				filter := strings.ToLower(strings.TrimSpace(a.filter.Get()))
				tree := a.projectTree(pinned, rest, filter)
				var children []core.Node
				if filter != "" {
					// A search reads the whole project at once, each match under
					// the sessions above it, so nothing a match grew out of is
					// hidden behind a page or a folded row.
					if len(tree.visible) > 0 {
						children = append(children, a.groupedSessionRows(ws, append(append([]*session{}, pinned...), rest...), tree)...)
					}
				} else {
					if len(pinned) > 0 {
						children = append(children, a.groupLabel(apptext.T("置顶")))
						children = append(children, core.View{Style: core.Style{Gap: 1}, Children: a.sessionRows(pinned, tree)})
					}
					// Paging counts what the reader can open, not the rows a
					// nested run adds: a page holds whole trees, so a subagent
					// never shows without the conversation that spawned it.
					f := buildSessionForest(rest, tree.parents)
					if tree.recent {
						f.sortByRecent(sessionUpdated)
					}
					page := min(len(f.roots), projectVisibleCount(ws))
					paged := sessionOrder(f, f.roots[:page])
					if len(paged) > 0 {
						children = append(children, a.groupedSessionRows(ws, paged, tree)...)
					}
					loading := ws.PiLoading.Get()
					if loading {
						children = append(children, a.projectLoadingRows()...)
					}
					hidden := len(rest) - forestCount(f, f.roots[:page])
					if !loading && (hidden > 0 || ws.Visible.Get() > 0) {
						children = append(children, a.projectMoreRow(ws, hidden))
					}
				}
				if len(children) == 0 {
					text := apptext.T("还没有会话")
					if filter != "" {
						text = apptext.T("没有匹配的会话")
					}
					children = append(children, core.Text{Content: text, Style: core.Style{FontSize: 12, Padding: core.Edges{Left: 8, Top: 5}},
						StyleFunc: ui.Colored(ui.ColorsOf(cx).Faint)})
				}
				return core.View{Style: core.Style{Gap: 1, Padding: core.Edges{Left: 11}}, Children: children}
			})
		}},
	}}
}

// projectNewSessionButton starts a session in this project, on the row.
func (a *app) projectNewSessionButton(w func() *workspace) core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{
		OnPress: func(core.PressEvent) { a.newProjectSession(w()) },
		Role:    core.RoleButton, Label: apptext.T("在此新建会话"), TestID: "project-new-session",
		StyleFunc: func() core.Style {
			return core.Style{Width: core.Pt(20), Height: core.Pt(20), CornerRadius: 5, FlexShrink: 0,
				AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Transition: viewkit.PressMotion,
				Hover: &core.Style{Background: colors.Pressed()}, Active: &core.Style{Background: colors.Pressed()}}
		}, Children: []core.Node{ui.IconOf(lucide.Plus, 11, colors.Faint)}}
}

// projectMoreMenu is the project's menu on the row, the same as its
// right-click menu.
func (a *app) projectMoreMenu(w func() *workspace) core.Node {
	colors := ui.ColorsOf(a.cx)
	key := w().key()
	return ui.Menu{
		Open:         func() bool { return a.projectMoreOpen.Get() == key },
		OnOpenChange: func(open bool, _ base.Reason) { a.setProjectMoreOpen(key, open) },
		Placement:    core.PlaceBottom, Align: core.AlignEnd,
		Trigger: ui.Button{Icon: lucide.Ellipsis, Label: apptext.T("更多项目操作"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
			Side: 20, IconSize: 12, Tint: func() core.Color { return colors.Faint() }},
		TestID: "project-more-menu", Children: a.projectMenuItems(w),
	}
}

// setProjectMoreOpen opens or closes one project's row menu.
func (a *app) setProjectMoreOpen(key string, open bool) {
	if open {
		a.clearSessionHover()
		a.projectMoreOpen.Set(key)
		return
	}
	if a.projectMoreOpen.GetUntracked() == key {
		a.projectMoreOpen.Set("")
	}
}

// projectVisibleCount is how many of a project's sessions the rail shows:
// the first page until the user asks for more.
func projectVisibleCount(ws *workspace) int {
	n := ws.Visible.Get()
	if n <= 0 {
		return projectSessionPage
	}
	return n
}

// projectSessionTotal counts a project's sessions, pi's own included and
// duplicates by id once.
func projectSessionTotal(ws *workspace) int {
	seen := map[string]struct{}{}
	for _, list := range []*core.Signal[[]*session]{ws.Sessions, ws.Pi} {
		for _, s := range list.Get() {
			if s != nil {
				seen[s.ID] = struct{}{}
			}
		}
	}
	return len(seen)
}

// projectCount is a project's session count, pulsing while pi's history is
// still being read.
func (a *app) projectCount(ws *workspace) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		if ws.PiLoading.Get() {
			return core.View{TestID: "project-count-loading", Accessible: true, Label: apptext.T("正在读取会话数量"),
				Style:    core.Style{Width: core.Pt(13), Height: core.Pt(8), AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter},
				Children: []core.Node{ui.SkeletonBlock{Width: core.Pt(13), Height: core.Pt(8)}}}
		}
		return core.View{TestID: "project-count", Children: []core.Node{
			core.Text{Content: fmt.Sprint(projectSessionTotal(ws)), Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11},
				StyleFunc: ui.Colored(colors.Faint)}}}
	})
}

// projectLoadingRows stand in for a project's history while it is read.
func (a *app) projectLoadingRows() []core.Node {
	rows := make([]core.Node, 0, 3)
	for i := 0; i < 3; i++ {
		rows = append(rows, core.View{TestID: "project-loading-row", Accessible: true, Label: apptext.T("正在读取历史会话"),
			Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Height: core.Pt(28), Padding: core.Symmetric(0, 8)},
			Children: []core.Node{
				ui.SkeletonBlock{Width: core.Pt(6), Height: core.Pt(6), Round: true, Index: i * 3},
				core.View{Style: core.Style{FlexGrow: 1, Gap: 4}, Children: []core.Node{
					ui.SkeletonBlock{Width: core.Pct(64), Height: core.Pt(6), Index: i*3 + 1},
					ui.SkeletonBlock{Width: core.Pct(36), Height: core.Pt(5), Index: i*3 + 2},
				}},
			}})
	}
	return rows
}

// projectMoreRow shows the next page of a project's sessions and the way
// back to the first one.
func (a *app) projectMoreRow(ws *workspace, hidden int) core.Node {
	colors := ui.ColorsOf(a.cx)
	action := func(label string, icon func() *core.SVG, testID string, press func()) core.View {
		return core.View{OnPress: func(core.PressEvent) { press() }, Role: core.RoleButton, Label: label, TestID: testID,
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, Height: core.Pt(24),
					Padding: core.Symmetric(0, 6), CornerRadius: 5, Transition: viewkit.PressMotion,
					Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
			},
			Children: []core.Node{ui.Icon(icon, 11, colors.Faint), ui.Text(label, viewkit.PanelCaptionSize, ui.Medium, colors.Muted)}}
	}
	var children []core.Node
	if hidden > 0 {
		more := action(apptext.T("更多"), lucide.ChevronDown, "project-more", func() {
			a.animateNextLayout()
			n := ws.Visible.GetUntracked()
			if n <= 0 {
				n = projectSessionPage
			}
			ws.Visible.Set(n + projectSessionStep)
		})
		more.Children = append(more.Children, ui.Text(fmt.Sprintf("(%d)", hidden), viewkit.PanelMicroSize, ui.Regular, colors.Faint))
		children = append(children, more)
	}
	if ws.Visible.GetUntracked() > 0 {
		children = append(children, action(apptext.T("收起"), lucide.ChevronUp, "project-collapse", func() {
			a.animateNextLayout()
			ws.Visible.Set(0)
		}))
	}
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 2, Padding: core.Edges{Left: 4}}, Children: children}
}
