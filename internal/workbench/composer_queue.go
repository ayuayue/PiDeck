//go:build !js && !android && !ios

package workbench

import (
	"time"

	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

type queueAction uint8

const (
	queueRecall queueAction = iota
	queueDelete
	queueSwitch
)

func newQueuedMessage(at time.Time, text string, images []remotewire.Image) queuedMessage {
	return queuedMessage{ID: newSessionID(), Text: text, Images: append([]remotewire.Image(nil), images...), At: at}
}

// reconcileSteering keeps attachment metadata beside pi's authoritative text
// projection. Equal messages match FIFO; an enqueue may expand a template.
func reconcileSteering(known []queuedMessage, texts []string, keepPending bool) []queuedMessage {
	out := make([]queuedMessage, 0, len(texts))
	used := make([]bool, len(known))
	counts, drops := map[string]int{}, map[string]int{}
	for _, text := range texts {
		counts[text]++
	}
	for _, msg := range known {
		if msg.Pending {
			continue
		}
		text := msg.QueueText
		if text == "" {
			text = msg.Text
		}
		drops[text]++
	}
	for text, count := range drops {
		drops[text] = max(0, count-counts[text])
	}
	for _, text := range texts {
		match := -1
		for i, msg := range known {
			if !used[i] && (msg.QueueText == text || (msg.QueueText == "" && msg.Text == text)) {
				if !msg.Pending && drops[text] > 0 {
					// pi consumes identical messages from the front as well.
					used[i] = true
					drops[text]--
					continue
				}
				match = i
				break
			}
		}
		if match < 0 {
			for i, msg := range known {
				if !used[i] && msg.Pending && msg.QueueText == "" {
					match = i
					break
				}
			}
		}
		msg := queuedMessage{}
		if match >= 0 {
			used[match] = true
			msg = known[match]
		} else {
			msg = newQueuedMessage(time.Time{}, text, nil)
		}
		msg.QueueText, msg.Pending = text, false
		out = append(out, msg)
	}
	if keepPending {
		for i, msg := range known {
			if !used[i] && msg.Pending {
				out = append(out, msg)
			}
		}
	}
	return out
}

func (a *app) updateSteering(s *session, texts []string) {
	if s.queueEditing {
		s.queueLatest, s.queueSeen = append([]string(nil), texts...), true
		return
	}
	s.steering.Set(reconcileSteering(s.steering.GetUntracked(), texts, true))
}

func (s *session) queueWorking() bool {
	return s != nil && s.queueBusy != nil && s.queueBusy.GetUntracked()
}

// runQueueCommand serializes enqueue, clear/rebuild and stop without blocking
// the UI. The next command waits until the previous result has been published.
func (a *app) runQueueCommand(s *session, work func() func()) {
	previous := s.queueTail
	done := make(chan struct{})
	s.queueTail = done
	s.queueOps++
	if s.queueBusy != nil {
		s.queueBusy.Set(true)
	}
	go func() {
		if previous != nil {
			<-previous
		}
		finish := work()
		a.cx.Post(func() {
			defer close(done)
			finish()
			s.queueOps--
			if s.queueBusy != nil {
				s.queueBusy.Set(s.queueOps > 0)
			}
			if s.queueOps == 0 {
				a.flushFollowUps(s)
			}
		})
	}()
}

func steerCommand(c *piClient, msg queuedMessage) error {
	text := msg.Text
	if msg.QueueText != "" {
		text = msg.QueueText
	}
	cmd := map[string]any{"type": "steer", "message": text}
	if images := encodeImages(msg.Images); images != nil {
		cmd["images"] = images
	}
	return c.call(cmd, nil, 30*time.Second)
}

func (a *app) enqueueSteer(s *session, msg queuedMessage) {
	if backendOf(s) == "acp" {
		s.sending.Update(func(list []queuedMessage) []queuedMessage { return append(append([]queuedMessage(nil), list...), msg) })
		return
	}
	if s.engine == nil {
		a.ensureEngine(s, func() { a.enqueueSteer(s, msg) })
		return
	}
	msg.Pending = true
	s.steering.Update(func(list []queuedMessage) []queuedMessage { return append(append([]queuedMessage(nil), list...), msg) })
	c := s.engine
	a.runQueueCommand(s, func() func() {
		err := steerCommand(c, msg)
		return func() {
			if s.engine != c {
				return
			}
			// A handled input produces no queue event. A consumed message was
			// already removed by its event, so neither should reappear here.
			for _, queued := range s.steering.GetUntracked() {
				if queued.ID == msg.ID && queued.Pending {
					rest, _ := takeQueued(s.steering.GetUntracked(), msg.ID)
					s.steering.Set(rest)
					if err != nil {
						a.restoreQueuedDraft(s, msg, nil)
					}
					break
				}
			}
			if err != nil {
				a.toast(ui.ToastError, "引导发送失败", err.Error())
			}
		}
	})
}

func (a *app) restoreQueuedDraft(s *session, msg queuedMessage, editor *core.Ref) {
	draft := s.draft.GetUntracked()
	text := msg.Text
	if draft != "" {
		if text != "" {
			text += "\n\n"
		}
		text += draft
	}
	s.draft.Set(text)
	if len(msg.Images) > 0 {
		s.images.Update(func(images []remotewire.Image) []remotewire.Image {
			return append(append([]remotewire.Image(nil), msg.Images...), images...)
		})
	}
	if editor != nil {
		editor.Focus()
	}
}

func (a *app) editQueue(s *session, id, source string, action queueAction, editor *core.Ref) {
	if s == nil || s.queueWorking() || (action == queueSwitch && backendOf(s) == "acp") {
		return
	}
	if id != "" && source == deliveryFollowUp {
		rest, msg := takeQueued(s.sending.GetUntracked(), id)
		if msg == nil {
			return
		}
		s.sending.Set(rest)
		switch action {
		case queueRecall:
			a.restoreQueuedDraft(s, *msg, editor)
		case queueSwitch:
			a.enqueueSteer(s, *msg)
		}
		return
	}
	if s.engine == nil || backendOf(s) == "acp" {
		if id == "" {
			s.sending.Set(nil)
		}
		return
	}
	a.editSteering(s, id, action, editor)
}

// pi only exposes clear_queue. Its response, rather than the earlier screen
// snapshot, decides which messages can still be recalled or re-enqueued.
func (a *app) editSteering(s *session, id string, action queueAction, editor *core.Ref) {
	c := s.engine
	known := append([]queuedMessage(nil), s.steering.GetUntracked()...)
	held := append([]queuedMessage(nil), s.sending.GetUntracked()...)
	s.queueEditing, s.queueSeen = true, false
	a.runQueueCommand(s, func() func() {
		var remaining struct {
			Steering []string `json:"steering"`
			FollowUp []string `json:"followUp"`
		}
		err := c.call(map[string]any{"type": "clear_queue"}, &remaining, 10*time.Second)
		cleared := err == nil
		var selected *queuedMessage
		var rebuilding, recovery, externalRecovery []queuedMessage
		if cleared && id != "" {
			rebuilding, selected = takeQueued(reconcileSteering(known, remaining.Steering, false), id)
			// Publish the inputs before sending them again. Every queue event
			// can then match its own pending input, even when equal texts have
			// different images or are consumed while a later send fails.
			ready := make(chan struct{})
			active := false
			a.cx.Post(func() {
				defer close(ready)
				if s.engine != c {
					return
				}
				list := make([]queuedMessage, 0, len(rebuilding))
				for _, msg := range rebuilding {
					msg.Pending, msg.QueueText = true, ""
					list = append(list, msg)
				}
				for _, msg := range s.steering.GetUntracked() {
					if msg.Pending {
						list = append(list, msg)
					}
				}
				s.steering.Set(list)
				s.queueEditing = false
				active = true
			})
			<-ready
			if active {
				for i, msg := range rebuilding {
					if err = steerCommand(c, msg); err != nil {
						recovery = append(recovery, rebuilding[i:]...)
						break
					}
				}
				// Preserve text-only queues created outside this composer.
				for _, text := range remaining.FollowUp {
					if err == nil {
						err = c.call(map[string]any{"type": "follow_up", "message": text}, nil, 30*time.Second)
						if err == nil {
							continue
						}
					}
					externalRecovery = append(externalRecovery, newQueuedMessage(time.Time{}, text, nil))
				}
			}
		}
		return func() {
			s.queueEditing = false
			if s.engine != c {
				return
			}
			if !cleared {
				if s.queueSeen {
					a.updateSteering(s, s.queueLatest)
				}
				a.toast(ui.ToastError, "操作失败", err.Error())
				return
			}
			if id == "" {
				var pending []queuedMessage
				for _, msg := range s.steering.GetUntracked() {
					if msg.Pending {
						pending = append(pending, msg)
					}
				}
				s.steering.Set(pending)
				for _, msg := range held {
					rest, _ := takeQueued(s.sending.GetUntracked(), msg.ID)
					s.sending.Set(rest)
				}
			} else if selected != nil {
				switch action {
				case queueRecall:
					a.restoreQueuedDraft(s, *selected, editor)
				case queueSwitch:
					s.sending.Update(func(list []queuedMessage) []queuedMessage {
						return append(append([]queuedMessage(nil), list...), *selected)
					})
				}
			}
			// Handled inputs need no queue row. Failed or unattempted inputs
			// return to the draft only if no event confirmed their delivery.
			for i := len(rebuilding) - 1; i >= 0; i-- {
				for _, msg := range s.steering.GetUntracked() {
					if msg.ID != rebuilding[i].ID || !msg.Pending {
						continue
					}
					rest, _ := takeQueued(s.steering.GetUntracked(), msg.ID)
					s.steering.Set(rest)
					for _, failed := range recovery {
						if failed.ID == msg.ID {
							a.restoreQueuedDraft(s, failed, editor)
							break
						}
					}
					break
				}
			}
			for i := len(externalRecovery) - 1; i >= 0; i-- {
				a.restoreQueuedDraft(s, externalRecovery[i], editor)
			}
			if err != nil {
				a.toast(ui.ToastError, "操作失败", err.Error())
			}
		}
	})
}
