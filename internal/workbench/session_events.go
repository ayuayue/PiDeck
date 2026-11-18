//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"encoding/json"
	"fmt"
	"strings"

	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// applyEvent hands one non-delta record to the state.
func (a *app) applyEvent(s *session, ev piEvent) {
	switch ev.Type {
	case "agent_start":
		s.status.Set(statusRunning)
		s.live = true
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
		s.notice.Set("正在压缩上下文…")
		a.addNote(s, "compaction", "压缩上下文", "正在压缩上下文…", chat.Waiting)
	case "compaction_end":
		if ev.ErrorMessage != "" {
			a.addNote(s, "compaction", "压缩失败", ev.ErrorMessage, chat.Failed)
			s.notice.Set("")
			s.status.Set(statusIdle)
			a.toast(ui.ToastError, "压缩失败", ev.ErrorMessage)
			return
		}
		if ev.Aborted {
			a.addNote(s, "compaction", "压缩已取消", "", chat.Cancelled)
			s.status.Set(statusIdle)
			s.notice.Set("")
			return
		}
		title := "上下文已压缩"
		body := ""
		var summary piCompaction
		if len(ev.Result) > 0 && json.Unmarshal(ev.Result, &summary) == nil {
			if summary.TokensBefore > 0 {
				title = fmt.Sprintf("上下文已压缩 · %s → %s", viewkit.Tokens(summary.TokensBefore), viewkit.Tokens(summary.EstimatedAfter))
			}
			body = summary.Summary
		}
		a.addNote(s, "compaction", title, body, chat.Completed)
		s.notice.Set("")
		if s.status.GetUntracked() == statusWaiting {
			s.status.Set(statusIdle)
		}
		a.startStats(s)
	case "queue_update":
		s.steering.Update(func(list []string) []string {
			return append([]string(nil), ev.Steering...)
		})
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
	ts := s.turns.GetUntracked()
	if len(ts) > 0 && ts[len(ts)-1].running() {
		return
	}
	s.turns.Update(func(ts []turn) []turn {
		return append(ts, turn{ID: fmt.Sprintf("t%d", a.cx.Now().UnixNano()), Status: chat.Running, Start: a.cx.Now()})
	})
}

// messageEnded commits an assistant message once it is authoritative.
func (a *app) messageEnded(s *session, ev piEvent) {
	var msg piMessage
	if len(ev.Message) == 0 || json.Unmarshal(ev.Message, &msg) != nil {
		return
	}
	switch msg.Role {
	case "assistant":
		a.commitAssistant(s, msg)
	case "toolResult":
		run := toolRun{CallID: msg.ToolCallID, Name: msg.ToolName, Output: strings.TrimSpace(msg.text()), IsError: msg.IsError}
		a.updateTool(s, run)
	}
}

// commitAssistant turns a finished message into steps, tools and usage.
func (a *app) commitAssistant(s *session, msg piMessage) {
	blocks := msg.blocks()
	var thinking, prose strings.Builder
	var calls []piContent
	for _, b := range blocks {
		switch b.Type {
		case "thinking":
			thinking.WriteString(b.Thinking)
		case "text":
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
			run = toolRun{CallID: c.ID, Name: c.Name, Action: action, Detail: detail, Status: chat.Running}
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
		t.Msgs++
		if strings.TrimSpace(thinking.String()) != "" {
			step.Thinking = thinking.String()
		}
		if text != "" && len(runs) > 0 {
			step.Text = text
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
