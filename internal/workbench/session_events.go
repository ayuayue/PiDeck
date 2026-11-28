//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// applyEvent hands one non-delta record to the state.
func (a *app) applyEvent(s *session, ev piEvent) {
	switch ev.Type {
	case "agent_start":
		s.status.Set(statusRunning)
		s.live = true
		a.ensureTurn(s)
	case "message_start":
		var msg piMessage
		if len(ev.Message) > 0 && json.Unmarshal(ev.Message, &msg) == nil && msg.Role == "assistant" {
			s.live = true
			s.mu.Lock()
			s.liveText.Reset()
			s.liveThink.Reset()
			s.showReset()
			s.flushDue = false
			s.mu.Unlock()
			a.cx.Batch(func() {
				s.streamText.Set("")
				s.streamThinking.Set("")
				s.liveTools.Set(nil)
			})
			// The reply's clock starts here: its first token and its total
			// are both counted from the message it answers.
			s.replyStart, s.replyTTFT = a.cx.Now(), 0
			a.ensureTurn(s)
		}
	case "message_end":
		a.messageEnded(s, ev)
	case "tool_execution_start":
		a.toolStarted(s, ev)
	case "tool_execution_update":
		a.toolUpdated(s, ev)
	case "tool_execution_end":
		a.toolEnded(s, ev)
	case "agent_end":
		if ev.WillRetry {
			s.status.Set(statusWaiting)
		}
	case "agent_settled":
		a.settled(s, ev)
	case "auto_retry_start":
		s.status.Set(statusWaiting)
		s.notice.Set(fmt.Sprintf("连接中断，%d 秒后重试（%d/%d）", max(1, ev.DelayMs/1000), ev.Attempt, ev.MaxAttempts))
		a.setTurnNotice(s, s.notice.GetUntracked())
	case "auto_retry_end":
		if ev.ErrorMessage != "" {
			s.notice.Set("")
			a.setTurnError(s, ev.ErrorMessage)
		} else {
			s.notice.Set("")
			a.setTurnNotice(s, "")
		}
	case "compaction_start":
		s.status.Set(statusWaiting)
		s.notice.Set(apptext.T("正在压缩上下文…"))
		a.addNote(s, "compaction", apptext.T("压缩上下文"), s.notice.GetUntracked(), chat.Waiting)
	case "compaction_end":
		title, body, status := apptext.T("上下文已压缩"), "", chat.Completed
		switch {
		case ev.ErrorMessage != "":
			title, body, status = apptext.T("压缩失败"), ev.ErrorMessage, chat.Failed
			a.toast(ui.ToastError, title, body)
		case ev.Aborted:
			title, status = apptext.T("压缩已取消"), chat.Cancelled
		default:
			var summary piCompaction
			if len(ev.Result) > 0 && json.Unmarshal(ev.Result, &summary) == nil {
				if summary.TokensBefore > 0 {
					title = apptext.T("上下文已压缩 · %s → %s", viewkit.Tokens(summary.TokensBefore), viewkit.Tokens(summary.EstimatedAfter))
				}
				body = summary.Summary
			}
			a.startStats(s)
		}
		a.addNote(s, "compaction", title, body, status)
		s.notice.Set("")
		if s.busyNow() {
			s.status.Set(statusRunning)
		} else {
			s.status.Set(statusIdle)
		}
	case "queue_update":
		a.updateSteering(s, ev.Steering)
	case "session_info_changed":
		if ev.Name != "" {
			s.title.Set(ev.Name)
			if a.st != nil {
				a.st.edit(func(c *config) { c.Titles[s.ID] = ev.Name })
			}
		}
	case "thinking_level_changed":
		if ev.Level != "" {
			s.thinking.Set(ev.Level)
		}
	case "extension_error":
		a.toast(ui.ToastError, "扩展出错", ev.ErrorMessage)
	}
}

// ensureTurn makes sure a running turn exists for a run that pi started.
func (a *app) ensureTurn(s *session) {
	s.runningSig.Set(true)
	ts := s.turns.GetUntracked()
	if len(ts) > 0 && !ts[len(ts)-1].System && ts[len(ts)-1].running() {
		return
	}
	s.turns.Update(func(ts []turn) []turn {
		return append(ts, turn{ID: fmt.Sprintf("t%d-%d", a.cx.Now().UnixNano(), len(ts)), Status: chat.Running, Start: a.cx.Now()})
	})
}

// resumePiTurn restores the run reported by get_state after a file/RPC
// history projection marked its messages completed. The transcript remains
// authoritative for the run; runningSig only mirrors it for the composer.
func (a *app) resumePiTurn(s *session) {
	s.turns.Update(func(ts []turn) []turn {
		for i := len(ts) - 1; i >= 0; i-- {
			if !ts[i].System {
				ts[i].Status, ts[i].End = chat.Running, time.Time{}
				// Streaming appends to the final turn; trailing system
				// records must stay separate from the resumed answer.
				active := ts[i]
				copy(ts[i:], ts[i+1:])
				ts[len(ts)-1] = active
				return ts
			}
		}
		return ts
	})
	a.ensureTurn(s)
}

// messageEnded commits an assistant message once it is authoritative.
func (a *app) messageEnded(s *session, ev piEvent) {
	if ev.finishedTool != nil {
		a.updateTool(s, *ev.finishedTool)
		return
	}
	var msg piMessage
	if len(ev.Message) == 0 || json.Unmarshal(ev.Message, &msg) != nil {
		return
	}
	switch msg.Role {
	case "user":
		a.recordPiInput(s, msg)
	case "custom":
		if _, state := delegationNotice(msg.text()); state != "" {
			a.recordPiInput(s, msg)
		}
	case "assistant":
		a.commitAssistant(s, msg)
	}
}

// recordPiInput fills a run started by the backend, including a delegate's
// wake-up prompt. Local prompt echoes keep their original display text;
// completion notices arriving during a run become notes in that same turn.
func (a *app) recordPiInput(s *session, msg piMessage) {
	text := msg.text()
	if text == "" && len(msg.blocks()) == 0 {
		return
	}
	if msg.Role == "custom" && !s.busyNow() {
		id, state := delegationNotice(text)
		status := chat.Completed
		switch state {
		case "失败":
			status = chat.Failed
		case "已停止":
			status = chat.Cancelled
		}
		a.addNote(s, "delegation-"+id, apptext.T("子代理与工作流"), text, status)
		return
	}
	a.ensureTurn(s)
	s.turns.Update(func(ts []turn) []turn {
		i := len(ts) - 1
		if ts[i].Prompt == "" {
			ts[i].Prompt, ts[i].sourcePrompt = text, text
			ts[i].Images = piBlockImages(msg.blocks())
		} else if _, state := delegationNotice(text); state != "" && ts[i].Prompt != text {
			ts[i].Steps = append(ts[i].Steps, turnStep{ID: fmt.Sprintf("%s-notice-%d", ts[i].ID, len(ts[i].Steps)),
				Note: apptext.T("子代理与工作流"), Text: text})
		}
		return ts
	})
}

// commitAssistant turns a finished message into steps, tools and usage.
func (a *app) commitAssistant(s *session, msg piMessage) {
	blocks := msg.blocks()
	var thinking, prose strings.Builder
	var calls []piContent
	// proseAt is how many calls came before the prose, so the step reads in
	// the order pi wrote it.
	proseAt := -1
	for _, b := range blocks {
		switch b.Type {
		case "thinking":
			thinking.WriteString(b.Thinking)
		case "text":
			if proseAt < 0 {
				proseAt = len(calls)
			}
			if prose.Len() > 0 {
				prose.WriteString("\n\n")
			}
			prose.WriteString(b.Text)
		case "toolCall":
			calls = append(calls, b)
		}
	}
	s.mu.Lock()
	s.shownText.WriteString(s.liveText.String())
	s.shownThink.WriteString(s.liveThink.String())
	liveText, liveThink := s.shownText.String(), s.shownThink.String()
	s.liveText.Reset()
	s.liveThink.Reset()
	s.showReset()
	s.flushDue = false
	s.mu.Unlock()
	if thinking.Len() == 0 && strings.TrimSpace(liveThink) != "" && len(calls) > 0 {
		// Some providers stream reasoning without a thinking block.
		thinking.WriteString(liveThink)
	}
	text := prose.String()
	if text == "" && len(calls) == 0 {
		text = liveText
	}

	// Tools known so far: the message's calls, updated with results.
	tools := s.liveTools.GetUntracked()
	byID := map[string]toolRun{}
	for _, t := range tools {
		byID[t.CallID] = t
	}
	var runs []toolRun
	for _, c := range calls {
		run, ok := byID[c.ID]
		if !ok {
			action, detail := toolSummary(c.Name, c.Arguments)
			run = toolRun{CallID: c.ID, Name: c.Name, Action: action, Detail: detail,
				filePaths: toolFileArgs(c.Arguments), Status: chat.Running}
		}
		runs = append(runs, run)
	}

	usage := usageInfo{}
	if msg.Usage != nil {
		usage = usageInfo{Input: msg.Usage.Input, Output: msg.Usage.Output, CacheRead: msg.Usage.CacheRead,
			CacheWrite: msg.Usage.CacheWrite, Total: msg.Usage.Total, Cost: msg.Usage.Cost.Total}
	}

	s.turns.Update(func(ts []turn) []turn {
		if len(ts) == 0 {
			return ts
		}
		i := len(ts) - 1
		t := &ts[i]
		if msg.Model != "" {
			t.Model = msg.Model
		}
		step := turnStep{ID: stepID(t, t.Msgs), Start: a.cx.Now()}
		// What the message took, as pi timed it: the window its reasoning and
		// its answer filled before it acted. Without pi's figure, the message's
		// own start is the clock.
		if d := time.Duration(msg.DurationMs) * time.Millisecond; d > 0 {
			step.Think = d
		} else if !s.replyStart.IsZero() {
			step.Think = step.Start.Sub(s.replyStart)
		}
		t.Msgs++
		if strings.TrimSpace(thinking.String()) != "" {
			step.Thinking = thinking.String()
		}
		if text != "" && len(runs) > 0 {
			step.Text = text
			step.TextAt = max(0, proseAt)
		}
		step.Tools = runs
		if step.Text != "" || step.Thinking != "" || len(step.Tools) > 0 {
			t.Steps = append(t.Steps, step)
		}
		if len(runs) == 0 && strings.TrimSpace(text) != "" {
			t.Final = text
		}
		t.Tools += len(runs)
		t.Usage = t.Usage.add(usage)
		if msg.StopReason == "error" && msg.ErrorMsg != "" {
			t.Err = msg.ErrorMsg
			t.Status = chat.Failed
		}
		return ts
	})
	if usage.Total > 0 || usage.Cost > 0 {
		s.usage.Update(func(u usageInfo) usageInfo { return u.add(usage) })
	}
	// The reply's pace and its cached share are what the usage panel shows;
	// a provider that reports no usage still has a duration.
	a.noteReplyPerf(s, usage)
	// The context window grew with this message: ask pi again so the ring
	// follows a multi-step turn instead of the turn's start.
	a.startStats(s)
	if msg.StopReason == "error" && msg.ErrorMsg != "" {
		s.status.Set(statusFailed)
	}
	a.cx.Batch(func() {
		s.streamText.Set("")
		s.streamThinking.Set("")
		s.liveTools.Set(nil)
		s.notice.Set("")
	})
}
