package client

import (
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
)

// The one pending tool result belongs to the connection/session that asked
// for it. Switching views never applies it to the next session's composer.
func (a *mobileApp) offerDraftChange(client *remoteClient, id, before, after string) {
	if a.client != client || after == "" || before == after {
		return
	}
	change := &viewkit.DraftChange{Before: before, After: after}
	if a.active.GetUntracked() == id && a.draft.GetUntracked() == before {
		a.draft.Set(after)
		change.Applied = true
	}
	a.draftChangeOwner = id
	a.draftChangeClient = client
	a.draftChange.Set(change)
}

func (a *mobileApp) applyDraftChange() {
	change := a.draftChange.GetUntracked()
	if change == nil || change.Applied || a.client != a.draftChangeClient || a.active.GetUntracked() != a.draftChangeOwner {
		return
	}
	a.draftChange.Set(&viewkit.DraftChange{Before: a.draft.GetUntracked(), After: change.After, Applied: true})
	a.draft.Set(change.After)
}

func (a *mobileApp) undoDraftChange() {
	change := a.draftChange.GetUntracked()
	if change == nil || !change.Applied || a.client != a.draftChangeClient || a.active.GetUntracked() != a.draftChangeOwner || a.draft.GetUntracked() != change.After {
		return
	}
	a.draft.Set(change.Before)
	a.draftChange.Set(nil)
}

func (a *mobileApp) draftChangeBar() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		change := a.draftChange.Get()
		if change == nil || a.active.Get() != a.draftChangeOwner || a.client != a.draftChangeClient {
			return nil
		}
		return viewkit.DraftChangeBar{Change: a.draftChange.Get, Draft: a.draft.Get,
			OnApply: a.applyDraftChange, OnUndo: a.undoDraftChange,
			OnDismiss: func() { a.draftChange.Set(nil) }, OnCopy: func(text string) { cx.SetClipboard(text) }}
	})
}
