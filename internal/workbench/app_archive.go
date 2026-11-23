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

// setArchived hides a session from the rail, or shows it again, and reports
// whether anything changed.
func (a *app) setArchived(id string, archived bool) bool {
	if id == "" || a.sessionArchived(id) == archived {
		return false
	}
	next := make([]string, 0, len(a.cfg.Archived)+1)
	if archived {
		next = append(next, id)
	}
	for _, x := range a.cfg.Archived {
		if x != id {
			next = append(next, x)
		}
	}
	a.cfg.Archived = next
	if a.st != nil {
		a.st.edit(func(c *config) { c.Archived = append([]string(nil), next...) })
	}
	a.archiveRev.Update(func(n int) int { return n + 1 })
	return true
}

// toggleArchive hides a session from the rail, or shows it again.
func (a *app) toggleArchive(s *session) {
	if s == nil {
		return
	}
	archive := !a.sessionArchived(s.ID)
	if !a.setArchived(s.ID, archive) {
		return
	}
	if archive {
		a.toast(ui.ToastSuccess, apptext.T("已归档"), s.title.GetUntracked())
		return
	}
	a.toast(ui.ToastSuccess, apptext.T("已取消归档"), s.title.GetUntracked())
}
