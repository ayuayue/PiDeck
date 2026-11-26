//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"encoding/json"
	"time"
)

// onPiEvent folds one stdout record; deltas coalesce, everything else posts.
func (a *app) onPiEvent(s *session, ev piEvent) {
	a.onPiEventGeneration(s, s.piGeneration.Load(), ev)
}

func (a *app) onPiEventGeneration(s *session, generation uint64, ev piEvent) {
	if s.piGeneration.Load() != generation {
		return
	}
	if ev.Type == "message_update" {
		a.onDeltaGeneration(s, generation, ev)
		return
	}
	prepareToolPreviews(&ev)
	if ev.Type == "message_end" {
		var msg piMessage
		if json.Unmarshal(ev.Message, &msg) == nil && msg.Role == "toolResult" {
			run := toolRunFromResult(msg)
			ev.finishedTool = &run
			ev.Message = nil
		}
	}
	a.cx.Post(func() {
		if s.piGeneration.Load() == generation && !s.deleting && a.byID[s.ID] == s {
			a.applyEvent(s, ev)
		}
	})
}

// onDelta buffers streaming text so the UI redraws at most ~25 times a
// second, however fast the provider talks.
func (a *app) onDelta(s *session, ev piEvent) {
	a.onDeltaGeneration(s, s.piGeneration.Load(), ev)
}

func (a *app) onDeltaGeneration(s *session, generation uint64, ev piEvent) {
	e := ev.AssistantMessageEvent
	if e == nil {
		return
	}
	switch e.Type {
	case "text_delta", "thinking_delta":
		if e.Delta == "" {
			return
		}
		s.mu.Lock()
		if s.piGeneration.Load() != generation {
			s.mu.Unlock()
			return
		}
		if e.Type == "text_delta" {
			s.liveText.WriteString(e.Delta)
		} else {
			s.liveThink.WriteString(e.Delta)
		}
		due := !s.flushDue
		s.flushDue = true
		s.mu.Unlock()
		if due {
			a.cx.Post(func() {
				if s.piGeneration.Load() == generation {
					a.scheduleFlush(s)
				}
			})
		}
	case "text_end", "thinking_end":
		s.mu.Lock()
		if s.piGeneration.Load() != generation {
			s.mu.Unlock()
			return
		}
		s.liveText.Reset()
		s.liveThink.Reset()
		if e.Type == "text_end" {
			s.shownText.Reset()
			s.shownText.WriteString(e.Content)
		} else {
			s.shownThink.Reset()
			s.shownThink.WriteString(e.Content)
		}
		s.mu.Unlock()
		a.cx.Post(func() {
			if s.piGeneration.Load() == generation {
				a.flushStream(s)
			}
		})
	}
}

func (a *app) scheduleFlush(s *session) {
	generation := s.piGeneration.Load()
	a.cx.AfterFunc(40*time.Millisecond, func() {
		if s.piGeneration.Load() == generation {
			a.flushStream(s)
		}
	})
}

// showReset clears what the stream showed; the caller holds s.mu.
func (s *session) showReset() {
	s.shownText.Reset()
	s.shownThink.Reset()
}

// flushStream publishes the buffered stream to its signals: deltas are
// appended to the shown text and the buffers taken, so a long answer stays
// linear in its size.
func (a *app) flushStream(s *session) {
	s.mu.Lock()
	s.shownText.WriteString(s.liveText.String())
	s.shownThink.WriteString(s.liveThink.String())
	s.liveText.Reset()
	s.liveThink.Reset()
	text, think := s.shownText.String(), s.shownThink.String()
	s.flushDue = false
	s.mu.Unlock()
	if text != "" || s.streamText.GetUntracked() != "" {
		s.streamText.Set(text)
	}
	if text != "" || think != "" {
		a.noteFirstToken(s)
	}
	if think != "" || s.streamThinking.GetUntracked() != "" {
		s.streamThinking.Set(think)
	}
}
