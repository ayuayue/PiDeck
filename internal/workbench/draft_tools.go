//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
)

// offerDraftChange never writes through a draft edited during an async request.
// A late result stays with its source session until copied, applied or closed.
func (a *app) offerDraftChange(s *session, before, after string) {
	if s.deleting || a.byID[s.ID] != s || after == "" || before == after {
		return
	}
	change := &viewkit.DraftChange{Before: before, After: after}
	if s.draft.GetUntracked() == before {
		s.draft.Set(after)
		change.Applied = true
	}
	s.draftChange.Set(change)
}

func (a *app) applyDraftChange(s *session) {
	change := s.draftChange.GetUntracked()
	if change == nil || change.Applied || s.deleting {
		return
	}
	s.draftChange.Set(&viewkit.DraftChange{Before: s.draft.GetUntracked(), After: change.After, Applied: true})
	s.draft.Set(change.After)
}

func (a *app) undoDraftChange(s *session) {
	change := s.draftChange.GetUntracked()
	if change == nil || !change.Applied || s.deleting || s.draft.GetUntracked() != change.After {
		return
	}
	s.draft.Set(change.Before)
	s.draftChange.Set(nil)
}

func (a *app) draftChangeBar(s *session) core.Node {
	return viewkit.DraftChangeBar{Change: s.draftChange.Get, Draft: s.draft.Get,
		OnApply: func() { a.applyDraftChange(s) }, OnUndo: func() { a.undoDraftChange(s) },
		OnDismiss: func() { s.draftChange.Set(nil) }, OnCopy: func(text string) { a.cx.SetClipboard(text) }}
}

// editTurnPrompt uses pi's existing branch projection; other backends only
// prepare a new message. Neither path rewrites an existing transcript.
func (a *app) editTurnPrompt(s *session, t turn) {
	if canBranchTurn(s, t) {
		a.forkSession(s, t.ID)
		return
	}
	a.restoreTurnDraft(s, t)
}

func (a *app) restoreTurnDraft(s *session, t turn) {
	// Only a blank composer is replaced automatically by a message action.
	// An occupied composer keeps its text and offers the explicit Replace.
	a.offerDraftChange(s, "", t.Prompt)
}
