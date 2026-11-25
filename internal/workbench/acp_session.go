//go:build !js && !android && !ios

package workbench

// ACP sessions: an external agent CLI in place of pi. Updates are
// projected into the same turns, steps and tool runs the transcript
// already draws, so the UI does not need a second timeline.

import (
	"fmt"
	"strings"
	"time"

	"example.com/pideck-v2/internal/alerts"
	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// newACPSession starts a session driven by an external ACP agent.
func (a *app) newACPSession(ws *workspace, preset acpPreset) *session {
	if ws == nil {
		a.toast(ui.ToastInfo, "先选一个项目", "ACP 会话要在项目里运行。")
		return nil
	}
	s := a.blankSession("acp-"+newSessionID(), ws, "ACP · "+preset.Name)
	s.backend = "acp"
	s.acpPreset = preset.ID
	ws.ACPPreset = preset.ID
	a.saveProjects()
	ws.Sessions.Update(func(ss []*session) []*session { return append([]*session{s}, ss...) })
	a.selectSession(s)
	a.sessionCreated(s, "acp")
	return s
}

// newACPSessionDefault starts the project's default ACP preset, or asks
// which one when it has none.
func (a *app) newACPSessionDefault() {
	ws := a.activeWorkspace()
	if ws == nil {
		a.toast(ui.ToastInfo, "先选一个项目", "ACP 会话要在项目里运行。")
		return
	}
	if ws.ACPPreset != "" {
		if p := a.acpPresetByID(ws.ACPPreset); p != nil {
			a.newACPSession(ws, *p)
			return
		}
	}
	a.acpOpenDialog()
}

// clearACPPreset forgets a project's default ACP preset.
func (a *app) clearACPPreset(ws *workspace) {
	if ws == nil {
		return
	}
	ws.ACPPreset = ""
	a.saveProjects()
}

// ensureACPSession starts the agent when it is not running.
func (a *app) ensureACPSession(s *session) {
	if s == nil || s.backend != "acp" || s.deleting || s.agentStopping {
		return
	}
	if s.acp != nil || s.starting {
		return
	}
	s.starting = true
	s.agentClosed = false
	started := make(chan *acpClient, 1)
	s.acpStarting = started
	s.acpGeneration++
	s.status.Set(statusStarting)
	go a.startACPEngine(s, s.acpGeneration, s.acpPreset, s.acpSID, s.WS, started)
}

// startACPEngine shakes hands and opens a session.
func (a *app) startACPEngine(s *session, generation uint64, presetID, savedID, cwd string, launched chan<- *acpClient) {
	started := time.Now()
	fail := func(detail string) {
		a.cx.Post(func() {
			if s.acpGeneration == generation {
				a.failSession(s, detail)
			}
		})
	}
	preset := a.acpPresetByID(presetID)
	if preset == nil {
		launched <- nil
		fail(apptext.T("没有这个 ACP 预设"))
		return
	}
	a.diagf("info", "ACP 启动 %s：%s %s", preset.Name, preset.Command, strings.Join(preset.Args, " "))
	handle := acpHooks{
		update: func(u acpUpdate) {
			a.cx.Post(func() {
				if s.acpGeneration == generation {
					a.applyACPUpdate(s, u)
				}
			})
		},
		permission: func(p acpPermission) string { return a.askACPPermission(s, generation, p) },
		exit:       func(err error) { a.cx.Post(func() { a.onACPExit(s, generation, err) }) },
	}
	// A handshaken spare skips the launch and the handshake; the session
	// only needs its session/new. A saved one may have died meanwhile.
	var c *acpClient
	if !s.Target.remote() {
		c = a.takeACPWarm(*preset, cwd)
	}
	if c != nil {
		c.setHooks(handle)
		launched <- c
	} else {
		var err error
		c, err = startACP(cwd, preset.Command, preset.Args, preset.envList(),
			handle.update, handle.permission, handle.exit)
		launched <- c
		if err != nil {
			a.diagf("error", "ACP 启动失败 %s：%v", preset.Name, err)
			fail(apptext.T("启动 ACP 失败：%s", err.Error()))
			return
		}
		// A first npx run downloads the package before it answers, which
		// looks like nothing happening: say what the tab waits for.
		a.cx.AfterFunc(8*time.Second, func() {
			if s.acpGeneration != generation || !s.starting {
				return
			}
			s.notice.Set(apptext.T("正在启动 %s…", preset.Name))
		})
		if _, err := c.initialize(); err != nil {
			c.stop()
			detail := acpStartDetail(err, c)
			a.diagf("error", "ACP 握手失败 %s（%s）：%s", preset.Name, time.Since(started).Round(time.Millisecond), detail)
			fail(apptext.T("ACP 握手失败：%s", detail))
			return
		}
	}
	handshake := time.Since(started)
	sid := ""
	modes := acpModeState{}
	loaded := false
	if savedID != "" {
		if st, err := c.loadSession(savedID, cwd); err == nil {
			sid = savedID
			modes = st
			loaded = true
		}
	}
	if sid == "" {
		var err error
		sid, modes, err = c.newSession(cwd)
		if err != nil {
			a.diagf("error", "ACP 建会话失败 %s：%v", preset.Name, err)
			c.stop()
			fail(apptext.T("ACP 建会话失败：%s", acpStartDetail(err, c)))
			return
		}
	}
	a.diagf("info", "ACP 就绪 %s：握手 %s，建会话 %s", preset.Name,
		handshake.Round(time.Millisecond), time.Since(started).Round(time.Millisecond))
	// The project's default preset stays warm for the next ACP session.
	a.cx.Post(func() {
		if s.acpGeneration != generation {
			return
		}
		if s.Target.remote() {
			return
		}
		if ws := a.workspaceFor(s.Target, s.WS); ws != nil && ws.ACPPreset == preset.ID {
			a.ensureWarmACP(*preset, cwd)
		}
	})
	// The CLI only takes a permission mode at runtime, and a refused call
	// must not block the session.
	var notice string
	modes, notice = a.applyACPAccess(c, *preset, sid, modes)
	if !loaded {
		modes = a.restoreACPChoices(c, presetID, sid, modes, acpPinnedMode(modes, *preset))
	}
	a.cx.Post(func() {
		if s.acpGeneration != generation || s.backend != "acp" {
			go c.stop()
			return
		}
		if c.isClosed() {
			a.failSession(s, apptext.T("ACP 进程退出了"))
			return
		}
		s.acp = c
		s.acpStarting = nil
		s.acpSID = sid
		s.starting = false
		if s.resumeDeletion() {
			return
		}
		s.acpModes.Set(modes.AvailableModes)
		s.acpMode.Set(modes.CurrentModeID)
		s.acpOptions.Set(modes.Options)
		s.acpOptionBusy.Set(false)
		s.readySig.Set(true)
		s.status.Set(statusIdle)
		s.notice.Set("")
		if savedID != "" && !loaded {
			a.toast(ui.ToastInfo, "ACP 会话未恢复", "Agent 未能恢复原会话，已创建新会话；本地记录仍可浏览，但不会自动成为 Agent 的上下文。")
		}
		if notice != "" {
			a.toast(ui.ToastInfo, "旁路权限", apptext.T(notice))
		}
		waiters := s.waiters
		s.waiters = nil
		for _, fn := range waiters {
			fn()
		}
	})
}

// acpStartDetail adds what the agent printed, so a failed start can be
// told from slow npm or a broken login without the log file.
func acpStartDetail(err error, c *acpClient) string {
	detail := err.Error()
	if stderr := c.stderrText(); stderr != "" && !strings.Contains(detail, stderr) {
		detail += " · " + stderr
	}
	return detail
}

// onACPExit tidies a session whose agent process ended.
func (a *app) onACPExit(s *session, generation uint64, err error) {
	if s == nil || s.acpGeneration != generation || s.acp == nil {
		return
	}
	s.acp = nil
	s.starting = false
	s.readySig.Set(false)
	s.acpOptionBusy.Set(false)
	a.cancelAsks(s)
	if err != nil {
		s.status.Set(statusFailed)
		s.notice.Set(err.Error())
		a.diagf("error", "ACP process disconnected")
	} else {
		s.status.Set(statusIdle)
		s.notice.Set("")
	}
	if s.acpTurnID != "" {
		a.acpFinish(s, s.acpTurnID, "cancelled", err)
	}
	if err != nil && a.activeID.GetUntracked() == s.ID {
		a.ensureACPSession(s)
	}
}

// reconnectACP restarts the agent process.
func (a *app) reconnectACP(s *session) {
	if s == nil || s.backend != "acp" {
		return
	}
	a.askRestartAgent(s)
}

// acpPrompt sends one turn and waits for its stop reason.
func (a *app) acpPrompt(s *session, turnID, text string, images []remotewire.Image) {
	s.acpTurnID = turnID
	if s.acp == nil || s.acpSID == "" {
		a.acpFinish(s, turnID, "", fmt.Errorf("%s", apptext.T("ACP 连接没有就绪")))
		return
	}
	c, sid := s.acp, s.acpSID
	if len(images) > 0 && !c.imageSupported {
		a.acpFinish(s, turnID, "", fmt.Errorf("%s", apptext.T("这个 ACP 工具没有声明支持图片输入。")))
		return
	}
	a.saveACPArchive(s)
	s.status.Set(statusRunning)
	s.runningSig.Set(true)
	a.armACPWatchdog(s, c, turnID)
	go func() {
		stop, err := c.prompt(sid, text, images...)
		a.cx.Post(func() { a.acpFinish(s, turnID, stop, err) })
	}()
}

// acpFinish closes the turn.
func (a *app) acpFinish(s *session, turnID, stop string, err error) {
	if s.acpTurnID != turnID {
		return
	}
	switch s.acpStopReason {
	case acpStopManual:
		stop, err = "cancelled", nil
	case acpStopTimeout:
		err = fmt.Errorf("%s", apptext.T("ACP 长时间没有输出，本轮已停止。"))
	}
	s.acpStopReason = acpStopNone
	a.cancelAsks(s)
	a.flushACP(s)
	s.acpTurnID = ""
	s.runningSig.Set(false)
	s.turns.Update(func(ts []turn) []turn {
		for i := len(ts) - 1; i >= 0; i-- {
			if ts[i].ID != turnID {
				continue
			}
			for j := len(ts[i].Steps) - 1; j >= 0; j-- {
				ts[i].Final = ts[i].Steps[j].Text
				break
			}
			switch {
			case err != nil:
				ts[i].Status = chat.Failed
				ts[i].Err = err.Error()
			case stop == "cancelled":
				ts[i].Status = chat.Cancelled
			default:
				ts[i].Status = chat.Completed
			}
			for j := range ts[i].Steps {
				for k := range ts[i].Steps[j].Tools {
					if ts[i].Steps[j].Tools[k].Status == chat.Running || ts[i].Steps[j].Tools[k].Status == chat.Waiting {
						ts[i].Steps[j].Tools[k].Status = ts[i].Status
					}
				}
			}
			ts[i].End = a.cx.Now()
			break
		}
		return ts
	})
	if err != nil {
		s.status.Set(statusFailed)
		s.notice.Set(err.Error())
	} else {
		s.status.Set(statusIdle)
		s.notice.Set("")
	}
	a.touch(s)
	a.saveACPArchive(s)
	switch {
	case err != nil:
		a.playAlert(alerts.KindError)
		a.notifyFeishu(s, "失败", err.Error())
	case stop == "cancelled":
		a.notifyFeishu(s, "已停止", "")
	default:
		a.playAlert(alerts.KindDone)
		a.notifyTurnDone(s)
		a.notifyFeishu(s, "完成", lastAnswer(s))
	}
	status := "completed"
	switch {
	case err != nil:
		status = "failed"
	case stop == "cancelled":
		status = "cancelled"
	}
	detail := ""
	if err != nil {
		detail = err.Error()
	}
	a.emit(eventTurnDone, appEvent{Session: s, Data: map[string]string{
		"status": status, "answer": lastAnswer(s), "error": detail,
	}})
}

// applyACPUpdate folds one session/update into the running turn.
func (a *app) applyACPUpdate(s *session, u acpUpdate) {
	if s.acpSID != "" && u.SessionID != "" && u.SessionID != s.acpSID {
		return
	}
	if s.acpTurnID != "" {
		s.acpProgress = a.cx.Now()
	}
	switch u.Kind {
	case "config_option_update":
		s.acpOptions.Set(u.Options)
		return
	case "current_mode_update":
		s.acpMode.Set(u.Mode)
		return
	case "available_commands_update":
		s.acpCommands.Set(u.Commands)
		return
	}
	if s.acpTurnID == "" {
		return
	}
	switch u.Kind {
	case "agent_message_chunk", "agent_thought_chunk":
		if u.Text == "" {
			return
		}
		s.mu.Lock()
		if u.Kind == "agent_message_chunk" {
			s.acpText.WriteString(u.Text)
		} else {
			s.acpThink.WriteString(u.Text)
		}
		due := !s.acpFlushDue
		s.acpFlushDue = true
		s.mu.Unlock()
		if due {
			a.cx.AfterFunc(40*time.Millisecond, func() { a.flushACP(s) })
		}
	case "tool_call":
		run := acpToolRun(u, chat.Running)
		if run.Action == "" {
			run.Action = "工具"
		}
		a.updateACPTool(s, run, true)
	case "tool_call_update":
		status := chat.Running
		switch u.Status {
		case "completed", "success":
			status = chat.Completed
		case "failed", "error":
			status = chat.Failed
		case "cancelled":
			status = chat.Cancelled
		}
		a.updateACPTool(s, acpToolRun(u, status), false)
	}
}

// acpToolAction turns a tool kind into the transcript's verb.
func acpToolAction(kind string) string {
	switch kind {
	case "read":
		return "读取"
	case "edit":
		return "编辑"
	case "delete":
		return "删除"
	case "move":
		return "移动"
	case "search":
		return "搜索"
	case "execute":
		return "运行"
	case "think":
		return "思考"
	case "fetch":
		return "抓取"
	case "switch_mode":
		return "切换模式"
	}
	return ""
}

// acpToolRun projects a tool call into a tool run: its kind is the verb,
// its first location the target. Fields the update leaves out stay empty,
// so merging keeps what the initial call said.
func acpToolRun(u acpUpdate, status chat.Status) toolRun {
	run := toolRun{CallID: u.ToolID, Name: u.ToolName, Action: acpToolAction(u.ToolKind),
		Output: u.Text, Status: status}
	switch {
	case len(u.Locations) > 1:
		run.Detail = fmt.Sprintf("%s 等 %d 个文件", u.Locations[0], len(u.Locations))
	case len(u.Locations) == 1:
		run.Detail = u.Locations[0]
	default:
		run.Detail = u.Title
	}
	return run
}

// updateACPTool adds or merges a tool in the running turn's last step.
func (a *app) updateACPTool(s *session, run toolRun, add bool) {
	s.turns.Update(func(ts []turn) []turn {
		for i := len(ts) - 1; i >= 0; i-- {
			if ts[i].ID != s.acpTurnID {
				continue
			}
			if len(ts[i].Steps) == 0 {
				ts[i].Steps = append(ts[i].Steps, turnStep{ID: fmt.Sprintf("%s-s0", ts[i].ID)})
			}
			step := &ts[i].Steps[len(ts[i].Steps)-1]
			for j := range step.Tools {
				if step.Tools[j].CallID == run.CallID {
					step.Tools[j] = mergeRun(step.Tools[j], run)
					return ts
				}
			}
			if add {
				step.Tools = append(step.Tools, run)
				ts[i].Tools++
			}
			return ts
		}
		return ts
	})
}

// flushACP publishes buffered text into the running turn's last step.
func (a *app) flushACP(s *session) {
	s.mu.Lock()
	text, think := s.acpText.String(), s.acpThink.String()
	s.acpText.Reset()
	s.acpThink.Reset()
	s.acpFlushDue = false
	s.mu.Unlock()
	if text == "" && think == "" {
		return
	}
	s.turns.Update(func(ts []turn) []turn {
		for i := len(ts) - 1; i >= 0; i-- {
			if ts[i].ID != s.acpTurnID {
				continue
			}
			if len(ts[i].Steps) == 0 {
				ts[i].Steps = append(ts[i].Steps, turnStep{ID: fmt.Sprintf("%s-s0", ts[i].ID)})
			}
			step := &ts[i].Steps[len(ts[i].Steps)-1]
			step.Text += text
			step.Thinking += think
			return ts
		}
		return ts
	})
}

// setACPMode switches the running agent to another operating mode.
func (a *app) setACPMode(s *session, modeID string) {
	if s == nil || s.acp == nil || s.acpSID == "" || modeID == "" || s.busyNow() || s.acpOptionBusy.GetUntracked() {
		return
	}
	s.acpModeOpen.Set(false)
	if s.acpMode.Get() == modeID {
		return
	}
	c, sid := s.acp, s.acpSID
	s.acpOptionBusy.Set(true)
	go func() {
		err := c.setMode(sid, modeID)
		a.cx.Post(func() {
			if s.acp != c {
				return
			}
			s.acpOptionBusy.Set(false)
			if err != nil {
				a.toast(ui.ToastError, "切换模式失败", err.Error())
				return
			}
			s.acpMode.Set(modeID)
			a.rememberACPPreference(s.acpPreset, func(p *acpPreference) { p.Mode = modeID })
		})
	}()
}

// askACPPermission turns an agent's permission request into the app's
// select dialog and waits for the answer, on the agent's reader goroutine.
func (a *app) askACPPermission(s *session, generation uint64, req acpPermission) string {
	if len(req.Options) == 0 {
		return ""
	}
	key := req.Title
	if key == "" {
		key = req.ToolID
	}
	if decision := s.acpPermissionFor(key); decision != "" {
		if id := acpDecisionOption(req, decision); id != "" {
			return id
		}
	}
	names := make([]string, 0, len(req.Options))
	for _, o := range req.Options {
		names = append(names, o.Name)
	}
	answer := make(chan string, 1)
	ask := &extensionAsk{ID: fmt.Sprintf("acp-%d-%d", generation, req.ID), Method: "select",
		Title: apptext.T("工具权限：") + req.Title, Message: apptext.T("允许这次工具调用吗？"), Options: names,
		ACPReply: func(name string) {
			select {
			case answer <- name:
			default:
			}
		}}
	a.cx.Post(func() {
		if s.acpGeneration != generation || s.acpTurnID == "" || (req.SessionID != "" && req.SessionID != s.acpSID) {
			ask.ACPReply("")
			return
		}
		a.enqueueAsk(s, ask)
	})
	defer a.cx.Post(func() { a.dropAsk(s, ask) })
	timer := time.NewTimer(2 * time.Minute)
	defer timer.Stop()
	select {
	case name := <-answer:
		for _, o := range req.Options {
			if o.Name == name {
				if decision := acpOptionDecision(o.Kind); decision != "" {
					s.acpRememberPermission(key, decision)
					a.cx.Post(func() { a.saveACPArchive(s) })
				}
				return o.ID
			}
		}
		return ""
	case <-timer.C:
		return ""
	case <-req.Done:
		return ""
	}
}

// acpDecisionOption finds the option for a remembered decision.
func acpDecisionOption(req acpPermission, decision string) string {
	var kinds []string
	switch decision {
	case "allow":
		kinds = []string{"allow_always", "allow_once"}
	case "reject":
		kinds = []string{"reject_always", "reject_once"}
	}
	for _, kind := range kinds {
		for _, o := range req.Options {
			if o.Kind == kind {
				return o.ID
			}
		}
	}
	return ""
}

// acpOptionDecision is the decision a choice kind remembers, if any.
func acpOptionDecision(kind string) string {
	switch kind {
	case "allow_always":
		return "allow"
	case "reject_always":
		return "reject"
	}
	return ""
}

// acpPermissionFor reads a remembered decision.
func (s *session) acpPermissionFor(key string) string {
	if s == nil || key == "" {
		return ""
	}
	s.acpPermMu.Lock()
	defer s.acpPermMu.Unlock()
	return s.acpPerm[key]
}

// acpRememberPermission remembers an always decision.
func (s *session) acpRememberPermission(key, decision string) {
	if s == nil || key == "" || decision == "" {
		return
	}
	s.acpPermMu.Lock()
	defer s.acpPermMu.Unlock()
	if s.acpPerm == nil {
		s.acpPerm = map[string]string{}
	}
	s.acpPerm[key] = decision
}

// acpClearPermissions forgets every remembered decision.
func (s *session) acpClearPermissions() {
	if s == nil {
		return
	}
	s.acpPermMu.Lock()
	s.acpPerm = nil
	s.acpPermMu.Unlock()
}
