//go:build !js && !android && !ios

package workbench

// The rail's session rows: a project's sessions under the groups the user
// sorted them into, under time headings, and nested by the session each one
// grew out of.

import (
	"maps"
	"slices"
	"strings"
	"time"

	"example.com/pideck/internal/apptext"
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

// railTree is one project's sessions as the rail draws them: the parent of
// every session the project lists, what a search may show, and whether rows
// order by activity or by name.
type railTree struct {
	parents map[string]string
	visible map[string]bool // nil unless the rail is searching
	recent  bool
}

// projectTree builds the rail's tree for one project. A search keeps each
// match with the sessions above it, so a subagent found by name reads under
// the conversation that spawned it instead of nowhere.
func (a *app) projectTree(pinned, rest []*session, query string) railTree {
	all := append(append(make([]*session, 0, len(pinned)+len(rest)), pinned...), rest...)
	org := a.organization.Get()
	parents := sessionParents(all, org.Links, a.cfg.ForkParents)
	// A pinned session reads at the top of its project, so pinning pulls it
	// and what grew out of it out from under its parent.
	for _, s := range pinned {
		delete(parents, s.ID)
	}
	tree := railTree{parents: parents, recent: a.sessionSortMode() != "name"}
	if query != "" {
		tree.visible = sessionVisible(all, parents, func(s *session) bool {
			return containsQuery(s.title.Get(), query)
		})
	}
	return tree
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

// groupedSessionRows draws a project's sessions under their groups and time
// headings, nesting the ones that grew out of another.
func (a *app) groupedSessionRows(ws *workspace, list []*session, tree railTree) []core.Node {
	org := a.organization.Get()
	groups := sessionGroupTree(list, org.Groups)
	var out []core.Node
	for _, name := range slices.Sorted(maps.Keys(groups.children)) {
		out = append(out, a.sessionGroupNode(ws, groups.children[name], tree))
	}
	ungrouped := groups.sessions
	if tree.recent {
		f := buildSessionForest(ungrouped, tree.parents)
		f.sortByRecent(sessionUpdated)
		// The headings follow a root's newest activity, the same reading
		// its children were ordered by.
		for _, group := range sessionBucketsBy(f.roots, a.cx.Now(), func(s *session) time.Time { return f.recent[s.ID] }) {
			out = append(out, a.groupLabel(group.Label))
			out = append(out, a.sessionForestRows(f, group.Rows, tree.parents, tree.visible,
				sessionRowOpts{reserve: len(f.kids) > 0}, a.railActiveChain(tree.parents), 0)...)
		}
		return out
	}
	if len(ungrouped) > 0 {
		out = append(out, a.groupLabel(apptext.T("名称")))
		out = append(out, a.sessionRows(ungrouped, tree)...)
	}
	return out
}

// sessionRows draws one set of sessions, nested, with no heading of its own.
func (a *app) sessionRows(list []*session, tree railTree) []core.Node {
	f := buildSessionForest(list, tree.parents)
	if tree.recent {
		f.sortByRecent(sessionUpdated)
	}
	opts := sessionRowOpts{reserve: len(f.kids) > 0}
	return a.sessionForestRows(f, f.roots, tree.parents, tree.visible, opts, a.railActiveChain(tree.parents), 0)
}

// sessionUpdated is a session's own last activity, read the way its row
// reads it so a heading and the row under it never disagree.
func sessionUpdated(s *session) time.Time { return s.updated.Get() }

func (a *app) sessionGroupNode(ws *workspace, group *railSessionGroup, tree railTree) core.Node {
	colors := ui.ColorsOf(a.cx)
	key := ws.Target.key() + "|" + ws.Path + "|" + group.path
	filtering := tree.visible != nil
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
				nodes = append(nodes, a.sessionGroupNode(ws, group.children[name], tree))
			}
			nodes = append(nodes, a.sessionRows(group.sessions, tree)...)
			return core.View{Style: core.Style{Gap: 1, Padding: core.Edges{Left: 10}}, Children: nodes}
		}},
	}}
}
