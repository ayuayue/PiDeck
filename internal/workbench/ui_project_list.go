//go:build !js && !android && !ios

package workbench

// The window: a rail of projects and sessions, a bar of session tabs, the
// chat, and a drawer for the session's numbers and the project's files.

import (
	"fmt"
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// projectList is the workspace tree: pinned first, then the named groups.
func (a *app) projectList() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		_ = a.projectsRev.Get()
		// The groups are built from a copy of the projects, read untracked,
		// so the list has to watch the projects themselves: adding or
		// removing one changes nothing the revision counts.
		_ = a.workspaces.Get()
		groups := a.projectGroups()
		showHeaders := len(groups) > 1 || (len(groups) == 1 && groups[0].Name != "未分组")
		var out []core.Node
		for _, g := range groups {
			if showHeaders {
				out = append(out, a.groupLabel(g.Name))
			}
			for _, w := range g.Projects {
				ws := w
				out = append(out, a.workspaceBlock(func() *workspace { return ws }))
			}
		}
		return core.View{Style: core.Style{Gap: 2}, Children: out}
	})
}

// workspaceBlock is one project and, when open, its sessions.
func (a *app) workspaceBlock(w func() *workspace) core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{Style: core.Style{Gap: 2}, Children: []core.Node{
		base.ContextMenu{
			Trigger: core.View{
				OnPress: func(core.PressEvent) {
					a.animateNextLayout()
					w().Expanded.Update(func(v bool) bool { return !v })
				},
				Role: core.RoleButton, LabelFunc: func() string { return w().label() }, TestID: "project-row",
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Height: core.Pt(30), Padding: core.Symmetric(0, 8),
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
						Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12.5, FontWeight: ui.Medium},
						StyleFunc: ui.Colored(colors.Text)},
					core.Show{When: func() bool { return w().Target.remote() }, Then: func(*core.Scope) core.Node {
						return core.View{StyleFunc: func() core.Style {
							return core.Style{Padding: core.Symmetric(0, 4), CornerRadius: 3, Background: colors.Inset()}
						}, Children: []core.Node{
							ui.Text(w().Target.shortLabel(), 8.5, ui.Medium, colors.Muted),
						}}
					}},
					a.projectCount(w()),
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
				keep := func(list []*session) []*session {
					if filter == "" {
						return list
					}
					var out []*session
					for _, s := range list {
						if strings.Contains(strings.ToLower(s.title.Get()), filter) {
							out = append(out, s)
						}
					}
					return out
				}
				var children []core.Node
				rows := func(list []*session) []core.Node {
					out := make([]core.Node, 0, len(list))
					for _, s := range list {
						out = append(out, a.sessionRowFn(func() *session { return s }))
					}
					return out
				}
				if p := keep(pinned); len(p) > 0 {
					children = append(children, a.groupLabel(apptext.T("置顶")), core.View{Style: core.Style{Gap: 1}, Children: rows(p)})
				}
				rest = keep(rest)
				shown := len(rest)
				if filter == "" {
					shown = min(shown, projectVisibleCount(ws))
				}
				visibleRest := rest[:shown]
				if a.sessionSortMode() == "name" {
					if len(visibleRest) > 0 {
						children = append(children, a.groupLabel("名称"),
							core.View{Style: core.Style{Gap: 1}, Children: rows(visibleRest)})
					}
				} else {
					for _, g := range sessionBuckets(visibleRest, a.cx.Now()) {
						children = append(children, a.groupLabel(g.Label), core.View{Style: core.Style{Gap: 1}, Children: rows(g.Rows)})
					}
				}
				loading := ws.PiLoading.Get()
				if loading {
					children = append(children, a.projectLoadingRows()...)
				} else if len(children) == 0 {
					children = append(children, core.Text{Content: apptext.T("还没有会话"), Style: core.Style{FontSize: 11, Padding: core.Edges{Left: 8, Top: 4}},
						StyleFunc: ui.Colored(ui.ColorsOf(cx).Faint)})
				}
				hidden := len(rest) - shown
				if filter == "" && !loading && (hidden > 0 || ws.Visible.Get() > 0) {
					children = append(children, a.projectMoreRow(ws, hidden))
				}
				return core.View{Style: core.Style{Gap: 1, Padding: core.Edges{Left: 11}}, Children: children}
			})
		}},
	}}
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
			core.Text{Content: fmt.Sprint(projectSessionTotal(ws)), Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10},
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
			Children: []core.Node{ui.Icon(icon, 11, colors.Faint), ui.Text(label, 10.5, ui.Medium, colors.Muted)}}
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
		more.Children = append(more.Children, ui.Text(fmt.Sprintf("(%d)", hidden), 9, ui.Regular, colors.Faint))
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
