//go:build !js && !android && !ios

package workbench

import (
	"maps"
	"slices"
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

type railSessionGroup struct {
	name, path string
	sessions   []*session
	children   map[string]*railSessionGroup
}

func sessionGroupTree(sessions []*session, groups map[string]string) *railSessionGroup {
	root := &railSessionGroup{}
	for _, s := range sessions {
		group := root
		if path := groups[s.ID]; path != "" {
			for part := range strings.SplitSeq(path, "/") {
				if group.children == nil {
					group.children = make(map[string]*railSessionGroup)
				}
				child := group.children[part]
				if child == nil {
					path := part
					if group.path != "" {
						path = group.path + "/" + part
					}
					child = &railSessionGroup{name: part, path: path}
					group.children[part] = child
				}
				group = child
			}
		}
		group.sessions = append(group.sessions, s)
	}
	return root
}

func (a *app) groupedSessionRows(ws *workspace, sessions []*session, filtering bool) []core.Node {
	org := a.organization.Get()
	tree := sessionGroupTree(sessions, org.Groups)
	var out []core.Node
	for _, name := range slices.Sorted(maps.Keys(tree.children)) {
		out = append(out, a.sessionGroupNode(ws, tree.children[name], org.Links, filtering))
	}
	ungrouped, children := sessionLinkRows(tree.sessions, org.Links)
	if a.sessionSortMode() == "name" {
		if len(ungrouped) > 0 {
			out = append(out, a.groupLabel(apptext.T("名称")), a.linkedSessionRows(ungrouped, children, 0))
		}
	} else {
		for _, group := range sessionBuckets(ungrouped, a.cx.Now()) {
			out = append(out, a.groupLabel(group.Label), a.linkedSessionRows(group.Rows, children, 0))
		}
	}
	return out
}

func sessionLinkRows(sessions []*session, links map[string]sessionLink) ([]*session, map[string][]*session) {
	visible := make(map[string]bool, len(sessions))
	for _, s := range sessions {
		visible[s.ID] = true
	}
	var roots []*session
	children := make(map[string][]*session)
	for _, s := range sessions {
		parent := links[s.ID].Parent
		if parent != "" && visible[parent] {
			children[parent] = append(children[parent], s)
		} else {
			roots = append(roots, s)
		}
	}
	return roots, children
}

func (a *app) linkedSessionRows(rows []*session, children map[string][]*session, depth int) core.Node {
	var views []core.Node
	for _, s := range rows {
		views = append(views, a.sessionRowFn(func() *session { return s }))
		if child := children[s.ID]; len(child) > 0 {
			views = append(views, a.linkedSessionRows(child, children, depth+1))
		}
	}
	var left core.Points
	if depth > 0 && depth <= 5 {
		left = 10
	}
	return core.View{Style: core.Style{Gap: 1, Padding: core.Edges{Left: left}}, Children: views}
}

func (a *app) sessionGroupNode(ws *workspace, group *railSessionGroup, links map[string]sessionLink, filtering bool) core.Node {
	colors := ui.ColorsOf(a.cx)
	key := ws.Target.key() + "|" + ws.Path + "|" + group.path
	open := func() bool { return filtering || !a.organizationCollapsed.Get()[key] }
	trigger := core.View{Role: core.RoleButton, Label: group.path, TestID: "session-group-heading",
		OnPress: func(core.PressEvent) {
			if filtering {
				return
			}
			state := maps.Clone(a.organizationCollapsed.GetUntracked())
			if state == nil {
				state = make(map[string]bool)
			}
			state[key] = !state[key]
			a.organizationCollapsed.Set(state)
		}, StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinHeight: core.Pt(25),
				Padding: core.Symmetric(0, 7), CornerRadius: ui.RadiusControl, Hover: &core.Style{Background: colors.Hover()}}
		}, Children: []core.Node{
			ui.IconOf(func() *core.SVG {
				if open() {
					return lucide.ChevronDown()
				}
				return lucide.ChevronRight()
			}, 11, colors.Faint),
			ui.Icon(lucide.Folder, 12, colors.Muted),
			core.Text{Content: group.name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FontSize: 11.5, FontWeight: ui.Medium, MinWidth: core.Pt(0), FlexShrink: 1}, StyleFunc: ui.Colored(colors.Muted)},
		}}
	return core.View{Style: core.Style{Gap: 1}, Children: []core.Node{
		base.ContextMenu{Trigger: trigger, PopupStyleFunc: func() core.Style { return a.menuCard(a.cx) }, Children: []core.Node{
			a.menuRow(a.cx, lucide.Pencil, apptext.T("编辑会话分组"), "", false, func() {
				a.organizationInput.Set(group.path)
				a.organizationDialog.Set(sessionOrganizationDialog{kind: "rename", path: group.path, ws: ws})
			}),
		}},
		core.Show{When: open, Then: func(*core.Scope) core.Node {
			var nodes []core.Node
			for _, name := range slices.Sorted(maps.Keys(group.children)) {
				nodes = append(nodes, a.sessionGroupNode(ws, group.children[name], links, filtering))
			}
			roots, children := sessionLinkRows(group.sessions, links)
			nodes = append(nodes, a.linkedSessionRows(roots, children, 0))
			return core.View{Style: core.Style{Gap: 1, Padding: core.Edges{Left: 10}}, Children: nodes}
		}},
	}}
}
