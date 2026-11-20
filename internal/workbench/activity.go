//go:build !js && !android && !ios

package workbench

import (
	"sort"
	"time"
)

const activityLimit = 100

// activityItem is a live session that needs attention or is still running.
// The session signals stay authoritative; this is only an ordered view.
type activityItem struct {
	session *session
	waiting int
	running bool
	updated time.Time
}

func (a *app) activityItems() []activityItem {
	var items []activityItem
	for _, s := range a.allSessions() {
		if s == nil || s.deleting || s.askPending == nil || s.runningSig == nil {
			continue
		}
		waiting, running := s.askPending.Get(), s.runningSig.Get()
		if waiting == 0 && !running {
			continue
		}
		items = append(items, activityItem{session: s, waiting: waiting, running: running, updated: s.updated.Get()})
	}
	sort.SliceStable(items, func(i, j int) bool {
		if (items[i].waiting > 0) != (items[j].waiting > 0) {
			return items[i].waiting > 0
		}
		return items[i].updated.After(items[j].updated)
	})
	if len(items) > activityLimit {
		items = items[:activityLimit]
	}
	return items
}

func (a *app) activityGroups() (waiting, running int) {
	for _, s := range a.allSessions() {
		if s == nil || s.deleting || s.askPending == nil || s.runningSig == nil {
			continue
		}
		if s.askPending.Get() > 0 {
			waiting++
		}
		if s.runningSig.Get() {
			running++
		}
	}
	return waiting, running
}

func (a *app) activityCount() int {
	n := 0
	for _, s := range a.allSessions() {
		if s == nil || s.deleting || s.askPending == nil || s.runningSig == nil {
			continue
		}
		if s.askPending.Get() > 0 || s.runningSig.Get() {
			n++
		}
	}
	return n
}
