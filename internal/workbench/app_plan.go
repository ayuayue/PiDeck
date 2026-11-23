//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/ui"
)

// lastAnswer is the newest final text in a session.
func lastAnswer(s *session) string {
	if s == nil {
		return ""
	}
	ts := s.turns.GetUntracked()
	for i := len(ts) - 1; i >= 0; i-- {
		if ts[i].Final != "" {
			return ts[i].Final
		}
	}
	return ""
}

// executePlan asks pi to carry out the plan it just gave.
func (a *app) executePlan(s *session, t turn) {
	if s == nil || t.running() {
		return
	}
	a.submitTurn(s, apptext.T("按上面的计划执行。每完成一步，用一句话说明改了什么、怎么验证的。"), nil, false)
}

// editPlan puts a plan back in the composer for changes.
func (a *app) editPlan(s *session, t turn) {
	if s == nil {
		return
	}
	text := t.Final
	if text == "" {
		return
	}
	a.setAgentMode(s, modeNormal)
	s.draft.Set(text)
	a.toast(ui.ToastInfo, "计划已放回输入框", "改完可以直接发。")
}

// forkLastTurn forks at the newest user prompt.
func (a *app) forkLastTurn() {
	s := a.active()
	if s == nil {
		return
	}
	turns := s.turns.GetUntracked()
	for i := len(turns) - 1; i >= 0; i-- {
		if turns[i].Prompt != "" {
			a.forkSession(s, turns[i].ID)
			return
		}
	}
	a.toast(ui.ToastInfo, "没有可分叉的提问", "")
}
