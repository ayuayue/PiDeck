//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"strings"
	"time"
)

// askRename opens the rename dialog for a session.
func (a *app) askRename(s *session) {
	if s == nil {
		return
	}
	a.renameID = s.ID
	a.renameText.Set(s.title.GetUntracked())
	a.renameOpen.Set(true)
}

// rename applies the dialog's name.
func (a *app) rename() {
	s := a.byID[a.renameID]
	name := strings.TrimSpace(a.renameText.GetUntracked())
	if s == nil || name == "" {
		a.renameOpen.Set(false)
		return
	}
	s.title.Set(name)
	if a.st != nil {
		a.st.edit(func(c *config) { c.Titles[s.ID] = name })
	}
	if s.engine != nil {
		go func(c *piClient, name string) {
			_ = c.call(map[string]any{"type": "set_session_name", "name": name}, nil, 10*time.Second)
		}(s.engine, name)
	}
	a.renameOpen.Set(false)
}

// askConfirm opens a confirmation with a destructive action.
func (a *app) askConfirm(title, body, action string, fn func()) {
	a.askConfirmAs(false, title, body, action, fn)
}

// askConfirmPrimary opens a confirmation whose action is not destructive.
func (a *app) askConfirmPrimary(title, body, action string, fn func()) {
	a.askConfirmAs(true, title, body, action, fn)
}

func (a *app) askConfirmAs(primary bool, title, body, action string, fn func()) {
	a.confirmPrimary = primary
	a.confirmHead.Set(title)
	a.confirmBody.Set(body)
	a.confirmWhy.Set(action)
	a.confirmFn = fn
	a.confirmOpen.Set(true)
}

// confirm runs the pending action.
func (a *app) confirm() {
	a.confirmOpen.Set(false)
	if a.confirmFn != nil {
		fn := a.confirmFn
		a.confirmFn = nil
		fn()
	}
}
