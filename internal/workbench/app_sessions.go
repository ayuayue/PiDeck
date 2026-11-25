//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
)

// makeSession builds the signals of one stored session.
func (a *app) makeSession(m sessionMeta, t target) *session {
	if existing := a.byID[m.ID]; existing != nil {
		// pi's own session: its file is the authority, so a later reading
		// brings the name and time it has now. The object is kept, so an
		// open tab and the rail's row stay the same.
		if existing.External && m.External {
			if m.Updated.After(existing.updated.GetUntracked()) {
				existing.updated.Set(m.Updated)
			}
			if m.Title != "" && m.Title != existing.title.GetUntracked() {
				existing.title.Set(m.Title)
			}
			if m.Parent != "" {
				existing.Parent = m.Parent
			}
		}
		return existing
	}
	s := &session{
		ID:             m.ID,
		WS:             m.Cwd,
		Parent:         m.Parent,
		File:           m.File,
		Target:         t,
		External:       m.External,
		title:          core.NewSignal(a.cx, m.Title),
		status:         core.NewSignal(a.cx, statusIdle),
		turns:          core.NewSignalFunc(a.cx, []turn{}, nil),
		draft:          core.NewSignal(a.cx, ""),
		draftChange:    core.NewSignal(a.cx, (*viewkit.DraftChange)(nil)),
		images:         core.NewSignalFunc(a.cx, []remotewire.Image(nil), nil),
		dropPending:    core.NewSignal(a.cx, 0),
		model:          core.NewSignal(a.cx, modelInfo{}),
		models:         core.NewSignalFunc(a.cx, []modelInfo(nil), nil),
		modelsBusy:     core.NewSignal(a.cx, false),
		thinking:       core.NewSignal(a.cx, ""),
		levels:         core.NewSignalFunc(a.cx, []string(nil), nil),
		usage:          core.NewSignal(a.cx, usageInfo{}),
		perf:           core.NewSignal(a.cx, replyPerf{}),
		stats:          core.NewSignal(a.cx, sessionStats{}),
		updated:        core.NewSignal(a.cx, m.Updated),
		loaded:         core.NewSignal(a.cx, false),
		notice:         core.NewSignal(a.cx, ""),
		steering:       core.NewSignalFunc(a.cx, []string(nil), nil),
		sending:        core.NewSignalFunc(a.cx, []queuedMessage(nil), nil),
		ask:            core.NewSignalFunc(a.cx, (*extensionAsk)(nil), nil),
		askPending:     core.NewSignal(a.cx, 0),
		askUI:          core.NewSignalFunc(a.cx, askUIState{}, nil),
		askTexts:       core.NewSignalFunc(a.cx, map[string]string(nil), nil),
		window:         core.NewSignal(a.cx, 24),
		todos:          core.NewSignalFunc(a.cx, []todoItem(nil), nil),
		todoOpen:       core.NewSignal(a.cx, false),
		extWidgets:     map[string][]string{},
		runningSig:     core.NewSignal(a.cx, false),
		agentMode:      core.NewSignal(a.cx, modeNormal),
		sendMode:       core.NewSignal(a.cx, ""),
		goalPaused:     core.NewSignal(a.cx, false),
		readySig:       core.NewSignal(a.cx, false),
		retrying:       core.NewSignal(a.cx, false),
		modelOpen:      core.NewSignal(a.cx, false),
		modelQuery:     core.NewSignal(a.cx, ""),
		backendOpen:    core.NewSignal(a.cx, false),
		modeOpen:       core.NewSignal(a.cx, false),
		imageOpen2:     core.NewSignal(a.cx, false),
		toolsOpen:      core.NewSignal(a.cx, false),
		sendOpen:       core.NewSignal(a.cx, false),
		usageOpen:      core.NewSignal(a.cx, false),
		projectOpen:    core.NewSignal(a.cx, false),
		streamText:     core.NewSignal(a.cx, ""),
		streamThinking: core.NewSignal(a.cx, ""),
		liveTools:      core.NewSignalFunc(a.cx, []toolRun(nil), nil),
		extStatus:      map[string]string{},
		openTools:      map[string]bool{},
		openProc:       map[string]bool{},
		openFold:       map[string]bool{},
		procScroll:     map[string]*processFollow{},
		uiSeq:          core.NewSignal(a.cx, 0),
		acpCommands:    core.NewSignalFunc(a.cx, []acpCommand(nil), nil),
		acpMode:        core.NewSignal(a.cx, ""),
		acpModes:       core.NewSignalFunc(a.cx, []acpMode(nil), nil),
		acpOptions:     core.NewSignalFunc(a.cx, []acpConfigOption(nil), nil),
		acpOptionBusy:  core.NewSignal(a.cx, false),
		acpModeOpen:    core.NewSignal(a.cx, false),
	}
	if id := a.cfg.SessionPersonas[m.ID]; id != "" {
		s.personaID = id
	}
	s.conversation = newChatScroll(a.cx)
	a.byID[s.ID] = s
	a.all = append(a.all, s)
	a.observeSessionDraft(s)
	return s
}

// sessionOf finds an open session by id.
func (a *app) sessionOf(id string) *session { return a.byID[id] }

// toolOpen reports the user's choice for a tool row; auto is the default
// while they have not chosen, open for a call that is still running.
func (s *session) toolOpen(key string, auto bool) bool {
	if v, ok := s.openTools[key]; ok {
		return v
	}
	return auto
}

// toggleOpen opens or closes a row, remembering the user's choice.
func (s *session) toggleOpen(key string) {
	if s.openTools == nil {
		s.openTools = map[string]bool{}
	}
	s.openTools[key] = !s.openTools[key]
	if s.uiSeq != nil {
		s.uiSeq.Update(func(n int) int { return n + 1 })
	}
}

// procOpen reports whether a process group is open: the user's choice
// once they made one, and otherwise auto, which is whether the group is
// the one still running.
func (s *session) procOpen(key string, auto bool) bool {
	if v, ok := s.openProc[key]; ok {
		return v
	}
	return auto
}

// toggleProc opens or closes a process group and keeps the choice.
func (s *session) toggleProc(key string, auto bool) {
	if s.openProc == nil {
		s.openProc = map[string]bool{}
	}
	s.openProc[key] = !s.procOpen(key, auto)
	if s.uiSeq != nil {
		s.uiSeq.Update(func(n int) int { return n + 1 })
	}
}

// procFollow is how the open process group called key reads: its scroll
// view, made on first use, and where the reader stands in it.
func (s *session) procFollow(key string) *processFollow {
	if f, ok := s.procScroll[key]; ok {
		return f
	}
	if s.procScroll == nil {
		s.procScroll = map[string]*processFollow{}
	}
	f := &processFollow{following: true}
	s.procScroll[key] = f
	return f
}

// foldOpen reports whether a turn's process is unfolded: the user's choice
// once they made one, and otherwise auto.
func (s *session) foldOpen(key string, auto bool) bool {
	if v, ok := s.openFold[key]; ok {
		return v
	}
	return auto
}

// toggleFold unfolds or folds a turn's process and keeps the choice.
func (s *session) toggleFold(key string, auto bool) {
	if s.openFold == nil {
		s.openFold = map[string]bool{}
	}
	s.openFold[key] = !s.foldOpen(key, auto)
	if s.uiSeq != nil {
		s.uiSeq.Update(func(n int) int { return n + 1 })
	}
}

// pinnedSessions are the sessions the user keeps at the top, in their
// order.
func (a *app) pinnedSessions() []*session {
	var out []*session
	for _, id := range a.pinned.Get() {
		if s := a.byID[id]; s != nil {
			out = append(out, s)
		}
	}
	return out
}

// isPinned reports whether a session is kept at the top.
func (a *app) isPinned(id string) bool {
	for _, p := range a.pinned.Get() {
		if p == id {
			return true
		}
	}
	return false
}
