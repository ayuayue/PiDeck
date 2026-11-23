//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/ui"
)

// projectSessions is a project's sessions: the app's own and pi's in the
// same folder, pinned first, then by the chosen order. Pinned ones are
// shown under their own heading.
// sessionArchived reports whether the rail hides a session.
func (a *app) sessionArchived(id string) bool {
	for _, x := range a.cfg.Archived {
		if x == id {
			return true
		}
	}
	return false
}

// toggleArchive hides a session from the rail, or shows it again.
func (a *app) toggleArchive(s *session) {
	if s == nil {
		return
	}
	next := append([]string(nil), a.cfg.Archived...)
	found := -1
	for i, id := range next {
		if id == s.ID {
			found = i
			break
		}
	}
	if found >= 0 {
		next = append(next[:found], next[found+1:]...)
	} else {
		next = append([]string{s.ID}, next...)
	}
	a.cfg.Archived = next
	if a.st != nil {
		a.st.edit(func(c *config) { c.Archived = append([]string(nil), next...) })
	}
	a.archiveRev.Update(func(n int) int { return n + 1 })
	if found >= 0 {
		a.toast(ui.ToastSuccess, apptext.T("已取消归档"), s.title.GetUntracked())
	} else {
		a.toast(ui.ToastSuccess, apptext.T("已归档"), s.title.GetUntracked())
	}
}
