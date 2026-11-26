package client

import (
	"time"

	"example.com/pideck-v2/internal/remotewire"
)

type mobileSessionBranch struct {
	session remotewire.Session
	depth   int
}

// Keep families together even when an older parent has a recently active
// child. Missing parents and cycles remain visible as roots.
func mobileSessionBranches(sessions []remotewire.Session, now time.Time) (recent, earlier []mobileSessionBranch) {
	byID := make(map[string]remotewire.Session, len(sessions))
	for _, s := range sessions {
		byID[s.ID] = s
	}
	parents := make(map[string]string, len(sessions))
	for _, s := range sessions {
		parent, found := byID[s.ParentID]
		if !found || parent.ID == s.ID {
			continue
		}
		seen := map[string]bool{s.ID: true}
		valid := true
		for id, depth := parent.ID, 0; id != ""; depth++ {
			if seen[id] || depth >= 16 {
				valid = false
				break
			}
			seen[id] = true
			next, exists := byID[id]
			if !exists {
				break
			}
			id = next.ParentID
		}
		if valid {
			parents[s.ID] = parent.ID
		}
	}
	children := make(map[string][]remotewire.Session)
	for _, s := range sessions {
		children[parents[s.ID]] = append(children[parents[s.ID]], s)
	}
	visited := make(map[string]bool, len(sessions))
	var visit func(remotewire.Session, int, *[]mobileSessionBranch)
	visit = func(s remotewire.Session, depth int, family *[]mobileSessionBranch) {
		if visited[s.ID] {
			return
		}
		visited[s.ID] = true
		*family = append(*family, mobileSessionBranch{session: s, depth: depth})
		for _, child := range children[s.ID] {
			visit(child, depth+1, family)
		}
	}
	for _, root := range children[""] {
		var family []mobileSessionBranch
		visit(root, 0, &family)
		members := make([]remotewire.Session, 0, len(family))
		for _, row := range family {
			members = append(members, row.session)
		}
		visible, _ := splitRecentSessions(members, now)
		if len(visible) > 0 {
			recent = append(recent, family...)
		} else {
			earlier = append(earlier, family...)
		}
	}
	return recent, earlier
}
