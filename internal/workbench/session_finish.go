//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"example.com/pideck-lite/internal/alerts"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// settled ends the run and tidies the session.
func (a *app) settled(s *session, ev piEvent) {
	now := a.cx.Now()
	s.mu.Lock()
	s.liveText.Reset()
	s.liveThink.Reset()
	s.showReset()
	s.flushDue = false
	s.mu.Unlock()
	a.cx.Batch(func() {
		s.runningSig.Set(false)
		s.streamText.Set("")
		s.streamThinking.Set("")
		s.liveTools.Set(nil)
		s.notice.Set("")
		s.steering.Set(nil)
		s.turns.Update(func(ts []turn) []turn {
			for i := len(ts) - 1; i >= 0; i-- {
				if !ts[i].running() && !(ts[i].Status == chat.Failed && ts[i].End.IsZero()) {
					continue
				}
				if ts[i].Status == chat.Waiting {
					ts[i].Status = chat.Completed
				}
				if ev.Aborted {
					ts[i].Status = chat.Cancelled
				} else if ts[i].Err != "" || ts[i].Status == chat.Failed {
					ts[i].Status = chat.Failed
				} else {
					ts[i].Status = chat.Completed
				}
				ts[i].End = now
				break
			}
			return ts
		})
	})
	if !ev.Aborted && s.status.GetUntracked() != statusFailed {
		s.status.Set(statusIdle)
	} else if ev.Aborted {
		s.status.Set(statusIdle)
	}
	s.live = false
	a.touch(s)
	a.startStats(s)
	switch {
	case ev.Aborted:
		a.notifyFeishu(s, "已停止", "")
	case s.status.GetUntracked() == statusFailed:
		a.playAlert(alerts.KindError)
		a.notifyFeishu(s, "失败", s.notice.GetUntracked())
	default:
		a.playAlert(alerts.KindDone)
		a.notifyTurnDone(s)
		a.notifyFeishu(s, "完成", lastAnswer(s))
	}
	status := "completed"
	switch {
	case ev.Aborted:
		status = "cancelled"
	case s.status.GetUntracked() == statusFailed:
		status = "failed"
	}
	a.emit(eventTurnDone, appEvent{Session: s, Data: map[string]string{
		"status": status, "answer": lastAnswer(s), "error": s.notice.GetUntracked(),
	}})
	if a.activeID.GetUntracked() == s.ID && s.conversation.AtLatest() {
		s.conversation.JumpToLatest()
	}
}

// setTurnNotice writes a live note onto the running turn.
func (a *app) setTurnNotice(s *session, note string) {
	s.turns.Update(func(ts []turn) []turn {
		for i := len(ts) - 1; i >= 0; i-- {
			if ts[i].running() {
				ts[i].Noticed = note
				break
			}
		}
		return ts
	})
}

// setTurnError records an error on the running turn.
func (a *app) setTurnError(s *session, errText string) {
	s.turns.Update(func(ts []turn) []turn {
		for i := len(ts) - 1; i >= 0; i-- {
			if ts[i].running() {
				ts[i].Err = errText
				break
			}
		}
		return ts
	})
}

// addNote adds or updates a system note in the transcript.
func (a *app) addNote(s *session, kind, title, body string, status chat.Status) {
	id := "note-" + kind
	s.turns.Update(func(ts []turn) []turn {
		for i := range ts {
			if ts[i].ID == id {
				ts[i].Status = status
				ts[i].Noticed = title
				ts[i].Steps = []turnStep{{ID: id + "-step", Note: title, Text: body}}
				if status != chat.Waiting {
					ts[i].End = a.cx.Now()
				}
				return ts
			}
		}
		t := turn{ID: id, Status: status, Start: a.cx.Now(), Noticed: title,
			Steps: []turnStep{{ID: id + "-step", Note: title, Text: body}}}
		if status != chat.Waiting {
			t.End = a.cx.Now()
		}
		return append(ts, t)
	})
}
