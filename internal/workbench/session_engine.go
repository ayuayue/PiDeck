//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"time"

	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// ensureEngine starts pi for a session once, running then on the UI thread.
func (a *app) ensureEngine(s *session, then func()) {
	if s == nil {
		return
	}
	if s.backend == "acp" {
		if s.acp != nil {
			if then != nil {
				then()
			}
			return
		}
		if then != nil {
			s.waiters = append(s.waiters, then)
		}
		a.ensureACPSession(s)
		return
	}
	if s.engine != nil {
		if then != nil {
			then()
		}
		return
	}
	if then != nil {
		s.waiters = append(s.waiters, then)
	}
	if s.starting {
		return
	}
	if info := a.env.GetUntracked(); info.Probed && info.PiError != "" && !s.Target.remote() {
		a.failSession(s, "找不到 pi 命令："+info.PiError)
		return
	}
	s.starting = true
	s.status.Set(statusStarting)
	withBrowser := !s.Target.remote() && a.browserToolsExtension != "" && a.browser.owner.GetUntracked() == s.ID
	go a.startEngine(s, withBrowser)
}

// restartAgent stops a session's pi and starts it again: the way to pick
// up a changed model list or a stuck process without losing the tab.
func (a *app) restartAgent(s *session) {
	if s == nil {
		return
	}
	if s.backend == "acp" {
		if s.acp != nil {
			s.acp.stop()
			s.acp = nil
			s.acpSID = ""
		}
		s.readySig.Set(false)
		s.status.Set(statusIdle)
		a.ensureACPSession(s)
		return
	}
	if s.engine == nil {
		a.ensureEngine(s, nil)
		return
	}
	s.restarting = true
	s.engine.stop()
}

// closeAgent stops a session's pi and keeps the transcript and tab; the
// next message starts it again.
func (a *app) closeAgent(s *session) {
	if s == nil {
		return
	}
	if s.backend == "acp" {
		if s.acp != nil {
			s.acp.stop()
			s.acp = nil
			s.acpSID = ""
		}
		s.readySig.Set(false)
		s.status.Set(statusIdle)
		return
	}
	if s.engine == nil {
		return
	}
	s.engine.stop()
}

// startEngine spawns pi and reads its state, off the UI thread.
func (a *app) startEngine(s *session, withBrowser bool) {
	sessionFile := ""
	if s.External {
		sessionFile = s.File
	}
	var local piLocalTools
	var stopBrowser func()
	if withBrowser {
		url, token, stop, startErr := a.startBrowserTools(s)
		if startErr != nil {
			a.cx.Post(func() { a.browser.err.Set(startErr.Error()); a.revokeBrowser() })
			withBrowser = false
		} else {
			local = piLocalTools{extension: a.browserToolsExtension, env: []string{
				"PIDECK_LITE_BROWSER_URL=" + url,
				"PIDECK_LITE_BROWSER_TOKEN=" + token,
			}}
			stopBrowser = stop
		}
	}
	c, err := startPi(s.Target, a.piPath(), s.WS, a.st.sessions, s.ID, sessionFile,
		func(ev piEvent) { a.onPiEvent(s, ev) },
		func(req uiRequest) { a.onPiUI(s, req) },
		func(err error) {
			if stopBrowser != nil {
				stopBrowser()
			}
			a.onPiExit(s, err)
		}, local)
	if err != nil {
		if stopBrowser != nil {
			stopBrowser()
		}
		a.cx.Post(func() { a.failSession(s, err.Error()) })
		return
	}
	var state struct {
		Model         *modelInfo `json:"model"`
		ThinkingLevel string     `json:"thinkingLevel"`
		SessionFile   string     `json:"sessionFile"`
		SessionName   string     `json:"sessionName"`
		MessageCount  int        `json:"messageCount"`
		IsStreaming   bool       `json:"isStreaming"`
	}
	if err := c.call(map[string]any{"type": "get_state"}, &state, 40*time.Second); err != nil {
		c.stop()
		a.cx.Post(func() { a.failSession(s, "无法读取会话状态："+err.Error()) })
		return
	}
	a.cx.Post(func() {
		a.engineReady(s, c, state.Model, state.ThinkingLevel, state.SessionFile, state.MessageCount, state.IsStreaming)
	})
	if state.MessageCount == 0 {
		a.cx.Post(func() { a.historyReady(s) })
	} else {
		// A session file already on screen is not fetched again: pi counts
		// the same messages, so the tab is showing what get_messages would
		// send. A mismatch (a compacted session, a file lagging behind a
		// running turn) falls back to pi's copy.
		a.cx.Post(func() {
			if s.histFile == state.MessageCount {
				a.historyReady(s)
				return
			}
			go a.fetchHistory(s, c)
		})
	}
	var models struct {
		Models []modelInfo `json:"models"`
	}
	if err := c.call(map[string]any{"type": "get_available_models"}, &models, 40*time.Second); err == nil {
		a.cx.Post(func() { s.models.Set(models.Models) })
	}
	var levels struct {
		Levels []string `json:"levels"`
	}
	if err := c.call(map[string]any{"type": "get_available_thinking_levels"}, &levels, 40*time.Second); err == nil {
		a.cx.Post(func() { s.levels.Set(levels.Levels) })
	}
}

// engineReady records the process and applies defaults once the history is in.
func (a *app) engineReady(s *session, c *piClient, model *modelInfo, thinking, file string, count int, streaming bool) {
	s.engine = c
	s.starting = false
	s.readySig.Set(true)
	s.File = file
	if model != nil {
		s.model.Set(*model)
	}
	if thinking != "" {
		s.thinking.Set(thinking)
	}
	if streaming {
		s.status.Set(statusRunning)
		s.live = true
	} else {
		s.status.Set(statusIdle)
	}
	// The user's remembered model and thinking level win for a fresh session.
	if count == 0 {
		if a.defaultModel.ID != "" && (model == nil || model.ID != a.defaultModel.ID) {
			go a.applyModel(s, a.defaultModel.Provider, a.defaultModel.ID, false)
		}
		if a.defaultThinking != "" && thinking != a.defaultThinking {
			go a.applyThinking(s, a.defaultThinking, false)
		}
	}
	a.startStats(s)
}

// historyReady lets a session's queued actions run, now that its transcript
// can be seen. The messages came from the file or from get_messages.
func (a *app) historyReady(s *session) {
	if !s.loaded.GetUntracked() && a.activeID.GetUntracked() == s.ID {
		a.animateNextLayout()
	}
	s.loaded.Set(true)
	waiters := s.waiters
	s.waiters = nil
	for _, fn := range waiters {
		fn()
	}
	if a.activeID.GetUntracked() == s.ID {
		s.conversation.JumpToLatest()
	}
}

// historyFromPi replaces the transcript with pi's copy, which is what a
// compacted session (whose file holds more than its context) needs.
func (a *app) historyFromPi(s *session, msgs []piMessage) {
	if len(msgs) > 0 {
		a.fillHistory(s, msgs, true)
		s.histFile = 0 // the screen is pi's copy now, not the file's
	}
	a.historyReady(s)
}

// fetchHistory asks pi for a transcript the file could not stand in for.
func (a *app) fetchHistory(s *session, c *piClient) {
	var msgs struct {
		Messages []piMessage `json:"messages"`
	}
	if err := c.call(map[string]any{"type": "get_messages"}, &msgs, 40*time.Second); err == nil {
		a.cx.Post(func() { a.historyFromPi(s, msgs.Messages) })
		return
	}
	a.cx.Post(func() { a.historyReady(s) })
}

// fillHistory shows a session's messages, keeping anything that arrived
// while they were loading.
func (a *app) fillHistory(s *session, msgs []piMessage, replace bool) {
	history := turnsFromMessages(msgs)
	if !replace {
		// A message can arrive from the phone before the history is in; it
		// stays after what the session already had.
		if pending := s.turns.GetUntracked(); len(pending) > 0 {
			history = append(history, pending...)
		}
	}
	s.turns.Set(history)
	if items := todosFromMessages(msgs); len(items) > 0 {
		s.todos.Set(items)
	}
}

// loadHistoryFromFile paints a session's transcript from its file, so a tab
// shows its history while pi is still starting.
func (a *app) loadHistoryFromFile(s *session) {
	if s == nil || s.File == "" || s.backend == "acp" || s.Target.remote() || s.loaded.GetUntracked() {
		return
	}
	file := s.File
	go func() {
		msgs, err := sessionFileMessages(file)
		if err != nil || len(msgs) == 0 {
			return
		}
		a.cx.Post(func() {
			if s.loaded.GetUntracked() || s.File != file {
				return // pi answered first, or the tab moved on
			}
			if a.activeID.GetUntracked() == s.ID {
				a.animateNextLayout()
			}
			a.fillHistory(s, msgs, false)
			s.histFile = len(msgs)
			a.historyReady(s)
		})
	}()
}

// failSession ends a session that could not start.
func (a *app) failSession(s *session, why string) {
	s.starting = false
	s.readySig.Set(false)
	s.runningSig.Set(false)
	s.status.Set(statusFailed)
	s.notice.Set(why)
	s.waiters = nil
	s.turns.Update(func(ts []turn) []turn {
		for i := len(ts) - 1; i >= 0; i-- {
			if ts[i].running() {
				ts[i].Status = chat.Failed
				ts[i].Err = why
				ts[i].End = a.cx.Now()
				break
			}
		}
		return ts
	})
	a.toast(ui.ToastError, "pi 启动失败", why)
}

// onPiExit handles a process that ended; nil means it was asked to stop.
func (a *app) onPiExit(s *session, err error) {
	a.cx.Post(func() {
		if s.restarting {
			s.restarting = false
			s.engine = nil
			s.starting = false
			s.readySig.Set(false)
			s.waiters = nil
			s.status.Set(statusIdle)
			a.ensureEngine(s, nil)
			return
		}
		if s.engine == nil {
			return
		}
		s.engine = nil
		s.starting = false
		s.readySig.Set(false)
		s.waiters = nil
		if err == nil {
			s.status.Set(statusIdle)
			return
		}
		why := err.Error()
		s.status.Set(statusFailed)
		s.notice.Set("pi 进程退出了：" + why)
		s.turns.Update(func(ts []turn) []turn {
			for i := len(ts) - 1; i >= 0; i-- {
				if ts[i].running() {
					ts[i].Status = chat.Failed
					ts[i].Err = "pi 进程退出：" + why
					ts[i].End = a.cx.Now()
					break
				}
			}
			return ts
		})
		a.toast(ui.ToastError, "pi 进程退出", why)
	})
}

// startStats asks pi for the session's totals, when the engine is ready.
func (a *app) startStats(s *session) {
	if s != nil && s.backend == "acp" {
		return
	}
	c := s.engine
	if c == nil {
		return
	}
	var stats struct {
		UserMessages      int `json:"userMessages"`
		AssistantMessages int `json:"assistantMessages"`
		ToolCalls         int `json:"toolCalls"`
		Tokens            struct {
			Input      int `json:"input"`
			Output     int `json:"output"`
			CacheRead  int `json:"cacheRead"`
			CacheWrite int `json:"cacheWrite"`
			Total      int `json:"total"`
		} `json:"tokens"`
		Cost         float64 `json:"cost"`
		ContextUsage *struct {
			Tokens        int     `json:"tokens"`
			ContextWindow int     `json:"contextWindow"`
			Percent       float64 `json:"percent"`
		} `json:"contextUsage"`
	}
	go func() {
		if err := c.call(map[string]any{"type": "get_session_stats"}, &stats, 30*time.Second); err != nil {
			return
		}
		out := sessionStats{
			UserMessages: stats.UserMessages, AssistantMessages: stats.AssistantMessages, ToolCalls: stats.ToolCalls,
			Tokens: usageInfo{Input: stats.Tokens.Input, Output: stats.Tokens.Output, CacheRead: stats.Tokens.CacheRead,
				CacheWrite: stats.Tokens.CacheWrite, Total: stats.Tokens.Total, Cost: stats.Cost},
			Known: true,
		}
		if stats.ContextUsage != nil {
			out.ContextTokens = stats.ContextUsage.Tokens
			out.ContextWindow = stats.ContextUsage.ContextWindow
			out.ContextPercent = stats.ContextUsage.Percent
		}
		a.cx.Post(func() { s.stats.Set(out) })
	}()
}
