//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"time"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// ensureEngine starts pi for a session once, running then on the UI thread.
func (a *app) ensureEngine(s *session, then func()) {
	if s == nil || s.deleting || s.agentStopping || s.historyLoading || s.retryPendingNow() {
		return
	}
	s.agentClosed = false
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
	if s.engine != nil && !s.starting {
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
	generation := s.piGeneration.Add(1)
	started := make(chan *piClient, 1)
	s.piStarting = started
	s.status.Set(statusStarting)
	withMemory := a.cfg.MemoryTools && !s.Target.remote() && a.localToolsExtension != ""
	withTrajectory := a.cfg.RecordTrajectory && !s.Target.remote() && !s.External && a.localToolsExtension != ""
	withBrowser := !s.Target.remote() && a.localToolsExtension != "" && a.browser.owner.GetUntracked() == s.ID
	if w := s.warmPi; w != nil {
		// A prewarmed process carries no per-session tool server; when this
		// session needs one, boot a process that has it.
		if !withMemory && !withTrajectory && !withBrowser && !w.C.isClosed() {
			s.warmPi = nil
			go a.startEngineWarm(s, w.C, generation, started)
			return
		}
		s.warmPi = nil
		go w.C.stop()
	}
	go a.startEngine(s, generation, started, withMemory, withTrajectory, withBrowser)
}

// startEngineWarm takes over a prewarmed process: pi is already booted, so
// the session goes straight to reading its state.
func (a *app) startEngineWarm(s *session, c *piClient, generation uint64, started chan<- *piClient) {
	started <- c
	c.setHooks(hooks{
		onEvent: func(ev piEvent) { a.onPiEventGeneration(s, generation, ev) },
		onUI:    func(req uiRequest) { a.onPiUIGeneration(s, generation, req) },
		onExit:  func(err error) { a.onPiExit(s, generation, err) },
	})
	a.diagf("info", "会话接管 pi 预热进程 %s", shortPath(s.WS, 48))
	a.engineState(s, c, generation)
}

// startEngine spawns pi and reads its state, off the UI thread.
func (a *app) startEngine(s *session, generation uint64, started chan<- *piClient, withMemory, withTrajectory, withBrowser bool) {
	sessionFile := ""
	if s.External || s.Target.remote() {
		sessionFile = s.File
	}
	var local piLocalTools
	var listeners []func()
	closeTools := func() {
		for _, close := range listeners {
			close()
		}
	}
	if withMemory {
		url, token, closeListener, err := a.startMemoryTools(s)
		if err == nil {
			local = piLocalTools{extension: a.localToolsExtension, env: []string{"PIDECK_V2_MEMORY_URL=" + url, "PIDECK_V2_MEMORY_TOKEN=" + token}}
			listeners = append(listeners, closeListener)
		}
	}
	if withBrowser {
		url, token, closeListener, err := a.startPrivateTools(s, a.browserServer(s), func() bool {
			return a.browser.owner.GetUntracked() == s.ID
		})
		if err == nil {
			local.extension = a.localToolsExtension
			local.env = append(local.env, "PIDECK_V2_BROWSER_URL="+url, "PIDECK_V2_BROWSER_TOKEN="+token)
			listeners = append(listeners, closeListener)
		} else {
			a.cx.Post(func() { a.browser.err.Set(err.Error()); a.revokeBrowser() })
		}
	}
	if withTrajectory {
		local.extension = a.localToolsExtension
		local.env = append(local.env, "PIDECK_V2_TRACE=1")
	}
	c, err := startPi(s.Target, a.piPath(), s.WS, a.st.sessions, s.ID, sessionFile,
		func(ev piEvent) { a.onPiEventGeneration(s, generation, ev) },
		func(req uiRequest) { a.onPiUIGeneration(s, generation, req) },
		func(err error) { closeTools(); a.onPiExit(s, generation, err) }, local)
	started <- c
	if err != nil {
		closeTools()
		a.cx.Post(func() {
			if s.piGeneration.Load() == generation {
				a.failSession(s, err.Error())
			}
		})
		return
	}
	a.engineState(s, c, generation)
}

// engineState reads a started pi's state, transcript and options. It runs
// off the UI thread, for a process just spawned and for a warm one.
func (a *app) engineState(s *session, c *piClient, generation uint64) {
	if s.piGeneration.Load() != generation {
		return
	}
	a.cx.Post(func() {
		if s.piGeneration.Load() == generation {
			s.engine = c
		}
	})
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
		a.cx.Post(func() {
			if s.piGeneration.Load() == generation {
				a.failSession(s, "无法读取会话状态："+err.Error())
			}
		})
		return
	}
	a.cx.Post(func() {
		if s.piGeneration.Load() != generation || c.isClosed() {
			return
		}
		a.engineReady(s, c, state.Model, state.ThinkingLevel, state.SessionFile, state.MessageCount, state.IsStreaming)
	})
	if state.MessageCount == 0 {
		a.cx.Post(func() {
			if s.engine == c && s.piGeneration.Load() == generation {
				a.historyReady(s)
			}
		})
	} else {
		// A session file already on screen is not fetched again: pi counts
		// the same messages, so the tab is showing what get_messages would
		// send. A mismatch (a compacted session, a file lagging behind a
		// running turn) falls back to pi's copy.
		a.cx.Post(func() {
			if s.engine != c || s.piGeneration.Load() != generation {
				return
			}
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
		a.cx.Post(func() {
			if s.engine == c && s.piGeneration.Load() == generation {
				s.models.Set(models.Models)
			}
		})
	}
	var levels struct {
		Levels []string `json:"levels"`
	}
	if err := c.call(map[string]any{"type": "get_available_thinking_levels"}, &levels, 40*time.Second); err == nil {
		a.cx.Post(func() {
			if s.engine == c && s.piGeneration.Load() == generation {
				s.levels.Set(levels.Levels)
			}
		})
	}
}

// engineReady records the process and applies defaults once the history is in.
func (a *app) engineReady(s *session, c *piClient, model *modelInfo, thinking, file string, count int, streaming bool) {
	s.engine = c
	s.piStarting = nil
	s.starting = false
	s.File = file
	if file != "" {
		// A session file proves this install runs pi here, which is what
		// makes a spare worth booting for the next new session.
		a.warmOK = true
	}
	if s.resumeDeletion() {
		return
	}
	s.readySig.Set(true)
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
	if s.deleting || a.byID[s.ID] != s {
		return
	}
	if !s.loaded.GetUntracked() && a.activeID.GetUntracked() == s.ID {
		a.animateNextLayout()
	}
	s.loaded.Set(true)
	// A file can paint before the handshake completes. Its history must not
	// release pending prompts until the process has answered get_state.
	if s.starting && !s.readySig.GetUntracked() {
		return
	}
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
func (a *app) historyFromPi(s *session, history []turn, items []todoItem) {
	if len(history) > 0 {
		a.fillHistory(s, history, items, true)
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
		history, items := turnsFromMessages(msgs.Messages), todosFromMessages(msgs.Messages)
		a.cx.Post(func() {
			if s.engine != c {
				return
			}
			a.publishHistoryPerf(s, msgs.Messages)
			a.historyFromPi(s, history, items)
		})
		return
	}
	a.cx.Post(func() {
		if s.engine == c {
			a.historyReady(s)
		}
	})
}

// fillHistory shows a session's messages, keeping anything that arrived
// while they were loading.
func (a *app) fillHistory(s *session, history []turn, items []todoItem, replace bool) {
	if !replace {
		// A message can arrive from the phone before the history is in; it
		// stays after what the session already had.
		if pending := s.turns.GetUntracked(); len(pending) > 0 {
			history = append(history, pending...)
		}
	}
	s.turns.Set(history)
	if len(items) > 0 {
		s.todos.Set(items)
	}
}

// loadHistoryFromFile paints a session's transcript from its file, so a tab
// shows its history while pi is still starting.
func (a *app) loadHistoryFromFile(s *session) {
	if s == nil || s.File == "" || s.backend == "acp" || s.loaded.GetUntracked() {
		return
	}
	file, target := s.File, s.Target
	go func() {
		var msgs []piMessage
		var err error
		if target.remote() {
			msgs, err = targetHistoryMessages(target, file)
		} else {
			msgs, err = sessionFileMessages(file)
		}
		if err != nil || len(msgs) == 0 {
			return
		}
		history, items := turnsFromMessages(msgs), todosFromMessages(msgs)
		a.cx.Post(func() {
			if s.loaded.GetUntracked() || s.File != file {
				return // pi answered first, or the tab moved on
			}
			if a.activeID.GetUntracked() == s.ID {
				a.animateNextLayout()
			}
			a.publishHistoryPerf(s, msgs)
			a.fillHistory(s, history, items, false)
			s.histFile = len(msgs)
			a.historyReady(s)
		})
	}()
}

// failSession ends a session that could not start.
func (a *app) failSession(s *session, why string) {
	s.starting = false
	if s.backend != "acp" && s.engine != nil && s.engine.isClosed() {
		s.engine = nil
		s.piStarting = nil
		s.piGeneration.Add(1)
	}
	if s.resumeDeletion() {
		return
	}
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
	title := "pi 启动失败"
	if s.backend == "acp" {
		title = apptext.T("ACP 启动失败")
	}
	a.toast(ui.ToastError, title, why)
}

// onPiExit handles a process that ended; nil means it was asked to stop.
func (a *app) onPiExit(s *session, generation uint64, err error) {
	a.cx.Post(func() {
		if s.piGeneration.Load() != generation {
			return
		}
		if s.engine == nil {
			return
		}
		s.piGeneration.Add(1)
		s.historyGeneration++
		s.historyLoading = false
		runningID := ""
		for _, t := range s.turns.GetUntracked() {
			if t.running() {
				runningID = t.ID
			}
		}
		s.engine = nil
		s.piStarting = nil
		s.starting = false
		a.cancelPiTurn(s)
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
				if ts[i].ID == runningID {
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
		a.cx.Post(func() {
			if s.engine == c {
				s.stats.Set(out)
			}
		})
	}()
}
