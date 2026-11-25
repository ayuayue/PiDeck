//go:build !js && !android && !ios

package workbench

// The rail's nested session rows: the sessions that grew out of one read
// under it, behind a disclosure, so a persisted subagent does not push the
// conversation that spawned it out of the list.

import (
	"slices"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
)

// railOpen reports whether a session's children show: a search keeps every
// match in context, and the session on screen is always revealed, so a tab
// or a click never lands in a folded run. Otherwise the user's own choice
// stands, and a list nobody opened reads as its parents alone.
func (a *app) railOpen(id string, activeChain []string, filtering bool) bool {
	return railOpenFor(a.railExpanded.Get(), id, activeChain, filtering)
}

// railOpenFor is the rule behind the disclosure: what the user opened, the
// path to what is on screen, and a search that never hides a match.
func railOpenFor(expanded map[string]bool, id string, activeChain []string, filtering bool) bool {
	if filtering || slices.Contains(activeChain, id) {
		return true
	}
	return expanded[id]
}

// toggleRailExpanded opens or closes one session's children and keeps the
// choice.
func (a *app) toggleRailExpanded(id string) {
	a.railExpanded.Update(func(m map[string]bool) map[string]bool {
		next := make(map[string]bool, len(m)+1)
		for k, v := range m {
			next[k] = v
		}
		if next[id] {
			delete(next, id)
		} else {
			next[id] = true
		}
		return next
	})
}

// railActiveChain is the sessions above the one on screen, so the list can
// open what leads to it.
func (a *app) railActiveChain(parents map[string]string) []string {
	if a.activeID.Get() == "" {
		return nil
	}
	return sessionChain(parents, a.activeID.Get())
}

// sessionForestRows draws one level of a forest: a row per session, and
// behind its disclosure the sessions that grew out of it.
func (a *app) sessionForestRows(f *sessionForest, list []*session, parents map[string]string, visible map[string]bool,
	opts sessionRowOpts, activeChain []string, depth int) []core.Node {
	var out []core.Node
	for _, s := range list {
		if s == nil || (visible != nil && !visible[s.ID]) {
			continue
		}
		row := s
		kids := 0
		if depth < maxSessionDepth {
			for _, kid := range f.kids[row.ID] {
				if visible == nil || visible[kid.ID] {
					kids++
				}
			}
		}
		filtering := visible != nil
		open := func() bool { return a.railOpen(row.ID, activeChain, filtering) }
		rowOpts := opts
		rowOpts.kids = kids
		rowOpts.open = open
		rowOpts.toggle = func() { a.toggleRailExpanded(row.ID) }
		out = append(out, a.sessionRowWith(func() *session { return row }, rowOpts))
		if kids == 0 || !open() {
			continue
		}
		children := a.sessionForestRows(f, f.kids[row.ID], parents, visible, opts, activeChain, depth+1)
		if len(children) == 0 {
			continue
		}
		// The indent stops where a rail can still show a title: deeper runs
		// read in the same column, each still behind its own disclosure.
		var indent core.Points
		if depth < 3 {
			indent = 10
		}
		out = append(out, core.View{Style: core.Style{Gap: 1, Padding: core.Edges{Left: indent}}, Children: children})
	}
	return out
}

// forestCount counts the sessions a set of roots shows, the ones behind a
// folded row included: what a page of roots holds.
func forestCount(f *sessionForest, roots []*session) int {
	n := 0
	seen := map[string]bool{}
	var walk func(s *session, depth int)
	walk = func(s *session, depth int) {
		if s == nil || seen[s.ID] || depth > maxSessionDepth {
			return
		}
		seen[s.ID] = true
		n++
		for _, kid := range f.kids[s.ID] {
			walk(kid, depth+1)
		}
	}
	for _, root := range roots {
		walk(root, 0)
	}
	return n
}

// railToggleLabel is what the disclosure reads to a screen reader, naming
// how many sessions are behind it.
func railToggleLabel(kids int, open bool) string {
	if open {
		return apptext.T("折叠 %d 个子会话", kids)
	}
	return apptext.T("展开 %d 个子会话", kids)
}

// sessionOrder flattens a forest in reading order: each root, then what
// grew out of it, so a later pass that groups the same sessions keeps every
// parent above its children.
func sessionOrder(f *sessionForest, roots []*session) []*session {
	out := make([]*session, 0, len(roots))
	seen := map[string]bool{}
	var walk func(s *session, depth int)
	walk = func(s *session, depth int) {
		if s == nil || seen[s.ID] || depth > maxSessionDepth {
			return
		}
		seen[s.ID] = true
		out = append(out, s)
		for _, kid := range f.kids[s.ID] {
			walk(kid, depth+1)
		}
	}
	for _, root := range roots {
		walk(root, 0)
	}
	return out
}
