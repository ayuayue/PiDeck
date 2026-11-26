//go:build !js && !android && !ios

package workbench

import (
	"strings"
	"time"
)

const (
	sessionPrewarmDelay = 350 * time.Millisecond
	sessionPrewarmTTL   = 2 * time.Minute
)

func (s *session) cancelPrewarm() {
	s.prewarmSeq++
	s.prewarmPending = false
	if s.prewarmStop != nil {
		s.prewarmStop()
		s.prewarmStop = nil
	}
}

// Only editor changes schedule work. Restoring a draft, opening a tab or
// choosing a backend with an empty draft never starts a process.
func (a *app) scheduleSessionPrewarm(s *session) {
	if s == nil {
		return
	}
	s.cancelPrewarm()
	text := strings.TrimSpace(s.draft.GetUntracked())
	_, shell := shellDraft(text)
	if text == "" || shell || modeOn(s, modeImage) {
		a.retireSessionPrewarm(s)
		return
	}
	if !a.canPrewarmSession(s) {
		return
	}
	if s.historyLoading || s.agentStopping {
		s.prewarmPending = true
		return
	}
	if s.prewarming {
		a.expireSessionPrewarm(s)
		return
	}
	if s.hasAgent() {
		return
	}
	seq := s.prewarmSeq
	// Timers belong to the app, even when an editor event schedules them.
	a.cx.Run(func() {
		s.prewarmStop = a.cx.AfterFunc(sessionPrewarmDelay, func() {
			if s.prewarmSeq != seq || !a.canPrewarmSession(s) || s.hasAgent() {
				return
			}
			s.prewarmStop = nil
			if s.historyLoading || s.agentStopping {
				s.prewarmPending = true
				return
			}
			a.ensureEngine(s, nil)
			if s.hasAgent() {
				s.prewarming = true
				a.expireSessionPrewarm(s)
			}
		})
	})
}

func (a *app) canPrewarmSession(s *session) bool {
	return a.byID[s.ID] == s && a.activeID.GetUntracked() == s.ID &&
		(!a.paneVisible() || isFilePane(a.activePane.GetUntracked())) &&
		!s.deleting && !s.agentClosed &&
		!s.retryPendingNow() && !s.busyNow() && s.status.GetUntracked() != statusFailed &&
		s.askPending.GetUntracked() == 0 && a.projectTrusted(a.workspaceFor(s.Target, s.WS))
}

func (a *app) expireSessionPrewarm(s *session) {
	seq := s.prewarmSeq
	a.cx.Run(func() {
		s.prewarmStop = a.cx.AfterFunc(sessionPrewarmTTL, func() {
			if s.prewarmSeq == seq {
				a.retireSessionPrewarm(s)
			}
		})
	})
}

// Retire only speculative work; sending or explicitly starting an agent
// transfers ownership to the session and cancels this expiry.
func (a *app) retireSessionPrewarm(s *session) {
	if s == nil {
		return
	}
	s.cancelPrewarm()
	if !s.prewarming {
		return
	}
	s.prewarming = false
	if s.busyNow() || len(s.waiters) > 0 || s.askPending.GetUntracked() > 0 || !s.hasAgent() {
		return
	}
	a.stopSessionAgent(s, false)
	// Automatic expiry is not an explicit user close. Later input may warm again.
	s.agentClosed = false
}
