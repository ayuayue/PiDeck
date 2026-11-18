//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"sort"
	"strings"
	"time"
)

// findSession is a session by id, loaded or only listed in its project.
func (a *app) findSession(id string) *session {
	if s := a.byID[id]; s != nil {
		return s
	}
	for _, ws := range a.workspaces.GetUntracked() {
		for _, s := range ws.Sessions.GetUntracked() {
			if s != nil && s.ID == id {
				return s
			}
		}
		for _, s := range ws.Pi.GetUntracked() {
			if s != nil && s.ID == id {
				return s
			}
		}
	}
	return nil
}

// toggleShowArchived flips whether archived sessions show in the rail.
func (a *app) toggleShowArchived() {
	on := !a.cfg.ShowArchived
	a.cfg.ShowArchived = on
	if a.st != nil {
		a.st.edit(func(c *config) { c.ShowArchived = on })
	}
	a.archiveRev.Update(func(n int) int { return n + 1 })
}

func (a *app) projectSessions(ws *workspace) (pinned, rest []*session) {
	all := append(append([]*session{}, ws.Sessions.Get()...), ws.Pi.Get()...)
	seen := map[string]bool{}
	var list []*session
	for _, s := range all {
		if s == nil || seen[s.ID] {
			continue
		}
		seen[s.ID] = true
		list = append(list, s)
	}
	if !a.cfg.ShowArchived {
		kept := list[:0]
		for _, s := range list {
			if !a.sessionArchived(s.ID) {
				kept = append(kept, s)
			}
		}
		list = kept
	}
	sort.SliceStable(list, func(i, j int) bool {
		pi, pj := a.pinIndex(list[i].ID), a.pinIndex(list[j].ID)
		if (pi >= 0) != (pj >= 0) {
			return pi >= 0
		}
		if pi >= 0 && pj >= 0 && pi != pj {
			return pi < pj
		}
		if a.sessionSortMode() == "name" {
			return strings.ToLower(list[i].title.GetUntracked()) < strings.ToLower(list[j].title.GetUntracked())
		}
		return list[i].updated.GetUntracked().After(list[j].updated.GetUntracked())
	})
	for _, s := range list {
		if a.pinIndex(s.ID) >= 0 {
			pinned = append(pinned, s)
		} else {
			rest = append(rest, s)
		}
	}
	return pinned, rest
}

// sessionSortMode is the effective session order; recent activity is the
// default for configs written before a session order was chosen.
func (a *app) sessionSortMode() string {
	if a.cfg.SessionSort == "name" {
		return "name"
	}
	return "updated"
}

// pinIndex is a pinned session's place, -1 when it is not pinned.
func (a *app) pinIndex(id string) int {
	for i, p := range a.pinned.Get() {
		if p == id {
			return i
		}
	}
	return -1
}

// sessionGroup is a heading and the sessions under it.
type sessionGroup struct {
	Label string
	Rows  []*session
}

// sessionBuckets groups sessions by when they last changed.
func sessionBuckets(list []*session, now time.Time) []sessionGroup {
	type bucket struct {
		label string
		rows  []*session
	}
	var out []bucket
	label := func(t time.Time) string {
		d := now.Sub(t)
		switch {
		case sameDay(t, now):
			return "今天"
		case sameDay(t, now.Add(-24*time.Hour)):
			return "昨天"
		case d < 7*24*time.Hour:
			return "本周"
		}
		return "更早"
	}
	for _, s := range list {
		// Read as the row's own time label reads it, so a heading can
		// never say "昨天" over a row that says "刚刚": the readers of
		// the time are what rebuilds this grouping.
		l := label(s.updated.Get())
		if len(out) == 0 || out[len(out)-1].label != l {
			out = append(out, bucket{label: l})
		}
		out[len(out)-1].rows = append(out[len(out)-1].rows, s)
	}
	res := make([]sessionGroup, 0, len(out))
	for _, b := range out {
		res = append(res, sessionGroup{Label: b.label, Rows: b.rows})
	}
	return res
}

// sameDay reports whether two times fall on the same calendar day here.
func sameDay(a, b time.Time) bool {
	ay, am, ad := a.Date()
	by, bm, bd := b.Date()
	return ay == by && am == bm && ad == bd
}
