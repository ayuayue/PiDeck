//go:build !js && !android && !ios

package workbench

// The rail's session tree: a persisted subagent and a fork both name the
// session that spawned them, so they read under it instead of piling up
// beside it. The truth is the header pi wrote (parentSession); the app's
// own fork records and the links the user made fill in the rest.

import (
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// maxSessionDepth bounds a chain: a corrupt pair of headers must not walk
// for ever, and a listing indented past this reads as its own root anyway.
const maxSessionDepth = 16

// sessionParents resolves each session's parent inside one listing. The
// user's own link wins, then the session header, then the fork the app
// recorded. A parent outside the listing, the session itself, or a chain
// that loops back leaves that session a root: a subagent whose parent is
// in another folder still shows, it just cannot nest.
func sessionParents(sessions []*session, links map[string]sessionLink, forks map[string]string) map[string]string {
	if len(sessions) < 2 {
		return nil
	}
	byID := make(map[string]string, len(sessions))
	byFile := make(map[string]string, len(sessions))
	byName := make(map[string]string, len(sessions))
	for _, s := range sessions {
		if s == nil || s.ID == "" {
			continue
		}
		byID[s.ID] = s.ID
		if s.File != "" {
			byFile[pathKey(s.File)] = s.ID
			byName[sessionFileKey(s.File)] = s.ID
		}
	}
	parents := make(map[string]string, len(sessions))
	for _, s := range sessions {
		if s == nil || s.ID == "" {
			continue
		}
		if id := sessionParentOf(s, byID, byFile, byName, links, forks); id != "" && id != s.ID {
			parents[s.ID] = id
		}
	}
	// A chain that loops would hide its own sessions: drop the link that
	// closes the loop rather than follow it.
	for id := range parents {
		seen := map[string]bool{id: true}
		for up, ok := parents[id]; ok && up != ""; up, ok = parents[up] {
			if seen[up] || len(seen) > maxSessionDepth {
				delete(parents, id)
				break
			}
			seen[up] = true
		}
	}
	return parents
}

// sessionParentOf is one session's parent: the user's link, the header's
// parentSession, or the fork the app recorded.
func sessionParentOf(s *session, byID, byFile, byName map[string]string, links map[string]sessionLink, forks map[string]string) string {
	if parent := links[s.ID].Parent; parent != "" && byID[parent] != "" {
		return parent
	}
	if raw := strings.TrimSpace(s.Parent); raw != "" {
		if id := resolveSessionParent(raw, byID, byFile, byName); id != "" {
			return id
		}
	}
	if parent := forks[s.ID]; parent != "" && byID[parent] != "" {
		return parent
	}
	return ""
}

// resolveSessionParent names the session a header's parentSession points
// at. pi writes the parent's file path; an older or foreign writer may
// write an id instead, and a path copied through another platform keeps
// the same file name, so the name answers when the path does not.
func resolveSessionParent(raw string, byID, byFile, byName map[string]string) string {
	if byID[raw] != "" {
		return raw
	}
	if id := byFile[pathKey(raw)]; id != "" {
		return id
	}
	if id := byName[sessionFileKey(raw)]; id != "" {
		return id
	}
	// pi names a session file <timestamp>_<id>.jsonl: the id survives a
	// path that no longer matches the file on disk.
	name := sessionFileKey(raw)
	if i := strings.LastIndexByte(name, '_'); i >= 0 && i+1 < len(name) {
		if id := byID[name[i+1:]]; id != "" {
			return id
		}
	}
	return ""
}

// sessionFileKey is a session path's file name, lowercased and without the
// extension: the part two readings of one file agree on when the folder
// around it differs.
func sessionFileKey(path string) string {
	name := filepath.Base(strings.ReplaceAll(path, "\\", "/"))
	name = strings.TrimSuffix(strings.TrimSpace(name), ".jsonl")
	return strings.ToLower(name)
}

// sessionForest is one listing as roots and their children, in list order.
type sessionForest struct {
	roots []*session
	kids  map[string][]*session
	// recent is each session's newest activity anywhere below it, kept by
	// sortByRecent for the headings the roots are read under.
	recent map[string]time.Time
}

// buildSessionForest puts each session under its parent, keeping the order
// the listing came in. A parent outside the listing leaves its children as
// roots, so no session can be lost by nesting.
func buildSessionForest(sessions []*session, parents map[string]string) *sessionForest {
	f := &sessionForest{kids: map[string][]*session{}}
	present := make(map[string]bool, len(sessions))
	for _, s := range sessions {
		if s != nil {
			present[s.ID] = true
		}
	}
	for _, s := range sessions {
		if s == nil {
			continue
		}
		if parent := parents[s.ID]; parent != "" && present[parent] {
			f.kids[parent] = append(f.kids[parent], s)
			continue
		}
		f.roots = append(f.roots, s)
	}
	return f
}

// sortByRecent orders roots and each set of siblings by the newest
// activity anywhere below them, so a parent whose subagent just worked
// rises with it, as pi's own picker orders them. when reads a session's
// own activity, for the caller's tracking.
func (f *sessionForest) sortByRecent(when func(*session) time.Time) {
	recent := make(map[string]time.Time, len(f.roots))
	var walk func(s *session, depth int) time.Time
	walk = func(s *session, depth int) time.Time {
		at := when(s)
		if depth < maxSessionDepth {
			for _, kid := range f.kids[s.ID] {
				if next := walk(kid, depth+1); next.After(at) {
					at = next
				}
			}
		}
		recent[s.ID] = at
		return at
	}
	for _, root := range f.roots {
		walk(root, 0)
	}
	byRecent := func(list []*session) {
		before := make(map[string]int, len(list))
		for i, s := range list {
			before[s.ID] = i
		}
		sort.SliceStable(list, func(i, j int) bool {
			a, b := list[i], list[j]
			if recent[a.ID].Equal(recent[b.ID]) {
				return before[a.ID] < before[b.ID]
			}
			return recent[a.ID].After(recent[b.ID])
		})
	}
	byRecent(f.roots)
	for _, kids := range f.kids {
		byRecent(kids)
	}
	f.recent = recent
}

// sessionChain lists the sessions above id, topmost first. A chain longer
// than the depth cap stops there.
func sessionChain(parents map[string]string, id string) []string {
	var chain []string
	seen := map[string]bool{id: true}
	for up := parents[id]; up != "" && len(chain) < maxSessionDepth; up = parents[up] {
		if seen[up] {
			break
		}
		seen[up] = true
		chain = append(chain, up)
	}
	for i, j := 0, len(chain)-1; i < j; i, j = i+1, j-1 {
		chain[i], chain[j] = chain[j], chain[i]
	}
	return chain
}

// sessionVisible builds what a search shows: the sessions that matched and
// every ancestor that has to stand above them for the match to read in
// context.
func sessionVisible(sessions []*session, parents map[string]string, match func(*session) bool) map[string]bool {
	visible := make(map[string]bool, len(sessions))
	for _, s := range sessions {
		if s == nil || !match(s) {
			continue
		}
		visible[s.ID] = true
		for _, up := range sessionChain(parents, s.ID) {
			visible[up] = true
		}
	}
	return visible
}
