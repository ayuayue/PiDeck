//go:build !js

package main

// The fork tree: a session and every fork that grew out of it. The rail
// shows forks flat; this dialog shows the shape and opens any node.

import (
	"sort"
	"strings"

	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// forkNode is one session in a fork family.
type forkNode struct {
	ID      string
	Title   string
	Depth   int
	Current bool
	// Children is how many forks grew directly out of this one.
	Children int
}

// forkRoot walks up to the session with no recorded parent.
func forkRoot(parents map[string]string, id string) string {
	seen := map[string]bool{}
	for id != "" && parents[id] != "" && !seen[id] {
		seen[id] = true
		id = parents[id]
	}
	return id
}

// sessionTitle names a session whether it is open or only in the config.
func (a *app) sessionTitle(id string) string {
	if p := a.byID[id]; p != nil {
		return p.title.Get()
	}
	if t := a.cfg.Titles[id]; t != "" {
		return t
	}
	return T("未命名会话")
}

// forkFamily lists a session's whole fork family, depth first and in
// title order within a parent.
func (a *app) forkFamily(target string) []forkNode {
	if target == "" {
		return nil
	}
	parents := a.cfg.ForkParents
	root := forkRoot(parents, target)
	children := map[string][]string{}
	for child, parent := range parents {
		children[parent] = append(children[parent], child)
	}
	var out []forkNode
	visited := map[string]bool{}
	var walk func(id string, depth int)
	walk = func(id string, depth int) {
		if visited[id] || len(out) >= 200 {
			return
		}
		visited[id] = true
		out = append(out, forkNode{ID: id, Title: a.sessionTitle(id), Depth: depth, Current: id == target,
			Children: len(children[id])})
		kids := append([]string(nil), children[id]...)
		sort.SliceStable(kids, func(i, j int) bool {
			return strings.ToLower(a.sessionTitle(kids[i])) < strings.ToLower(a.sessionTitle(kids[j]))
		})
		for _, child := range kids {
			walk(child, depth+1)
		}
	}
	walk(root, 0)
	return out
}

// openForkTree shows the active session's fork family.
func (a *app) openForkTree() {
	if a.active() == nil {
		return
	}
	a.forksOpen.Set(true)
}

// forkTreeDialog draws the family and opens a node.
func (a *app) forkTreeDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		s := a.active()
		var nodes []forkNode
		if s != nil {
			nodes = a.forkFamily(s.ID)
		}
		collapsed := a.forkCollapsed.Get()
		var shown []forkNode
		hiddenDepth := -1
		for _, n := range nodes {
			if hiddenDepth >= 0 {
				if n.Depth > hiddenDepth {
					continue
				}
				hiddenDepth = -1
			}
			shown = append(shown, n)
			if collapsed[n.ID] && n.Children > 0 {
				hiddenDepth = n.Depth
			}
		}
		rows := make([]core.Node, 0, len(shown))
		for _, n := range shown {
			node := n
			open := a.byID[node.ID] != nil
			var toggle core.Node = core.View{Style: core.Style{Width: core.Pt(14), Height: core.Pt(14)}}
			if node.Children > 0 {
				folded := collapsed[node.ID]
				icon := lucide.ChevronDown
				label := T("折叠")
				if folded {
					icon = lucide.ChevronRight
					label = T("展开")
				}
				toggle = core.View{OnPress: func(core.PressEvent) {
					a.forkCollapsed.Update(func(m map[string]bool) map[string]bool {
						next := make(map[string]bool, len(m)+1)
						for k, v := range m {
							next[k] = v
						}
						if next[node.ID] {
							delete(next, node.ID)
						} else {
							next[node.ID] = true
						}
						return next
					})
				}, Role: core.RoleButton, Label: label + " " + node.Title, TestID: "fork-toggle-" + node.ID,
					StyleFunc: func() core.Style {
						return core.Style{Width: core.Pt(14), Height: core.Pt(14), AlignItems: core.AlignCenter,
							JustifyContent: core.JustifyCenter, CornerRadius: 3, Hover: &core.Style{Background: colors.Hover()}}
					}, Children: []core.Node{ui.Icon(icon, 10, colors.Faint)}}
			}
			row := []core.Node{
				core.View{Style: core.Style{Width: core.Pt(core.Points(node.Depth) * 14)}},
				toggle,
				ui.Icon(lucide.GitBranch, 11, colors.Faint),
				core.Text{Content: node.Title, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12},
					StyleFunc: ui.Colored(colors.Text)},
			}
			if node.Current {
				row = append(row, core.View{Style: core.Style{Padding: core.Symmetric(1, 5), CornerRadius: 4, Background: colors.Inset()},
					Children: []core.Node{ui.Text(T("当前"), 9, ui.Medium, colors.Faint)}})
			}
			rows = append(rows, core.View{
				OnPress: func(core.PressEvent) {
					if !open {
						return
					}
					a.forksOpen.Set(false)
					a.selectSession(a.byID[node.ID])
				},
				Role: core.RoleButton, Label: node.Title, TestID: "fork-node-" + node.ID,
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinHeight: core.Pt(30),
						Padding: core.Symmetric(2, 8), CornerRadius: 6,
						Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
				},
				Children: row,
			})
		}
		if len(rows) == 0 {
			rows = append(rows, core.Text{Content: T("没有分叉记录"), Style: core.Style{FontSize: 12, Padding: core.All(10)},
				StyleFunc: ui.Colored(colors.Faint)})
		}
		return ui.Dialog{
			Open:         a.forksOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.forksOpen.Set(open) },
			Title:        T("分叉树"),
			TestID:       "fork-tree",
			Style:        core.Style{Width: core.Pt(460)},
			Children: []core.Node{core.Scroll{Style: core.Style{MaxHeight: core.Pt(420)}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 1}, Children: rows}}}},
			Footer: []core.Node{
				ui.Button{Text: T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.forksOpen.Set(false) }},
			},
		}
	})
}
