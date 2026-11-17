//go:build !js && !android && !ios

package main

// ACP sessions: an external agent CLI in place of pi. Updates are
// projected into the same turns, steps and tool runs the transcript
// already draws, so the UI does not need a second timeline.

import (
	"fmt"
	"strings"
	"time"

	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
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
	if s == nil || s.backend != "acp" {
		return
	}
	if s.acp != nil || s.starting {
		return
	}
	s.starting = true
	s.status.Set(statusStarting)
	go a.startACPEngine(s)
}

// startACPEngine shakes hands and opens a session.
func (a *app) startACPEngine(s *session) {
	preset := a.acpPresetByID(s.acpPreset)
	if preset == nil {
		a.cx.Post(func() { a.failSession(s, "没有这个 ACP 预设") })
		return
	}
	c, err := startACP(s.WS, preset.Command, preset.Args,
		func(u acpUpdate) { a.cx.Post(func() { a.applyACPUpdate(s, u) }) },
		func(p acpPermission) string { return a.askACPPermission(s, p) },
		func(err error) { a.cx.Post(func() { a.onACPExit(s, err) }) })
	if err != nil {
		a.cx.Post(func() { a.failSession(s, "启动 ACP 失败："+err.Error()) })
		return
	}
	if _, err := c.initialize("PiDeck Lite", appVersion); err != nil {
		c.stop()
		a.cx.Post(func() { a.failSession(s, "ACP 握手失败："+err.Error()) })
		return
	}
	sid := ""
	modes := acpModeState{}
	if s.acpSID != "" {
		if st, err := c.loadSession(s.acpSID, s.WS); err == nil {
			sid = s.acpSID
			modes = st
		}
	}
	if sid == "" {
		var err error
		sid, modes, err = c.newSession(s.WS)
		if err != nil {
			c.stop()
			a.cx.Post(func() { a.failSession(s, "ACP 建会话失败："+err.Error()) })
			return
		}
	}
	a.cx.Post(func() {
		s.acp = c
		s.acpSID = sid
		s.acpModes.Set(modes.AvailableModes)
		s.acpMode.Set(modes.CurrentModeID)
		s.starting = false
		s.readySig.Set(true)
		s.status.Set(statusIdle)
		waiters := s.waiters
		s.waiters = nil
		for _, fn := range waiters {
			fn()
		}
	})
}

// onACPExit tidies a session whose agent process ended.
func (a *app) onACPExit(s *session, err error) {
	if s == nil || s.acp == nil {
		return
	}
	s.acp = nil
	s.starting = false
	s.readySig.Set(false)
	s.runningSig.Set(false)
	if err != nil {
		s.status.Set(statusFailed)
		s.notice.Set(err.Error())
		a.diagf("error", "ACP 进程退出 %s：%v", s.title.GetUntracked(), err)
	} else {
		s.status.Set(statusIdle)
		s.notice.Set("")
	}
	if s.acpTurnID != "" {
		a.acpFinish(s, s.acpTurnID, "cancelled", err)
	}
}

// reconnectACP restarts the agent process.
func (a *app) reconnectACP(s *session) {
	if s == nil || s.backend != "acp" {
		return
	}
	if s.acp != nil {
		s.acp.stop()
		s.acp = nil
	}
	s.readySig.Set(false)
	s.status.Set(statusIdle)
	a.ensureACPSession(s)
	a.toast(ui.ToastInfo, "正在重新连接 ACP", "")
}

// acpPrompt sends one turn and waits for its stop reason.
func (a *app) acpPrompt(s *session, turnID, text string) {
	if s.acp == nil || s.acpSID == "" {
		a.acpFinish(s, turnID, "", fmt.Errorf("ACP 连接没有就绪"))
		return
	}
	s.acpTurnID = turnID
	a.saveACPArchive(s)
	s.status.Set(statusRunning)
	s.runningSig.Set(true)
	go func() {
		stop, err := s.acp.prompt(s.acpSID, text)
		a.cx.Post(func() { a.acpFinish(s, turnID, stop, err) })
	}()
}

// acpFinish closes the turn.
func (a *app) acpFinish(s *session, turnID, stop string, err error) {
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
		a.notifyFeishu(s, "失败", err.Error())
	case stop == "cancelled":
		a.notifyFeishu(s, "已停止", "")
	default:
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
	case "current_mode_update":
		s.acpMode.Set(u.Mode)
	case "available_commands_update":
		s.acpCommands.Set(u.Commands)
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

// acpBadge names the ACP preset, its state and its mode, and opens the
// agent's own panel: the mode list, what it was started with, its commands
// and the way to reconnect.
func (a *app) acpBadge(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		preset := a.acpPresetByID(s.acpPreset)
		name := "ACP"
		if preset != nil {
			name = preset.Name
		}
		modes := s.acpModes.Get()
		label := name
		if mode := s.acpMode.Get(); mode != "" {
			label += " · " + acpModeLabel(modes, mode)
		}
		dot := colors.Faint
		switch {
		case s.status.Get() == statusFailed:
			dot = colors.Danger
		case s.starting && !s.readySig.Get():
			dot = colors.Warn
		case s.readySig.Get():
			dot = colors.Up
		}
		chip := core.View{OnPress: func(core.PressEvent) { s.acpModeOpen.Update(func(v bool) bool { return !v }) },
			Role: core.RoleButton, Label: T("ACP · %s", label), TestID: "acp-mode-badge",
			Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Height: core.Pt(26), FlexShrink: 0,
				Padding: core.Symmetric(0, 8), CornerRadius: 7, Background: colors.Inset(),
				Hover: &core.Style{Background: colors.Hover()}},
			Children: []core.Node{
				core.View{StyleFunc: func() core.Style {
					return core.Style{Width: core.Pt(6), Height: core.Pt(6), CornerRadius: 3, Background: dot()}
				}},
				core.Text{Content: label, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 11.5, MinWidth: core.Pt(0), FlexShrink: 1}, StyleFunc: ui.Colored(colors.Text)},
				ui.Icon(lucide.ChevronDown, 9.5, colors.Faint),
			}}
		trigger := hintOf(func() string {
			if s.readySig.Get() {
				return T("ACP · %s（点一下看模式与启动参数）", name)
			}
			return T("ACP · %s（启动中）", name)
		}, chip)
		return a.popoverCard(s.acpModeOpen, core.PlaceTop, core.AlignStart, 300, trigger, func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			var rows []core.Node
			if len(modes) > 0 {
				current := s.acpMode.Get()
				rows = append(rows, composerPanelTitle(cx, T("模式")))
				for _, m := range modes {
					mode := m
					title := mode.Name
					if title == "" {
						title = mode.ID
					}
					rows = append(rows, composerRow(cx, nil, title, mode.Description, mode.ID == current, false, func() {
						a.setACPMode(s, mode.ID)
					}))
				}
				rows = append(rows, composerDivider(cx))
			}
			if s.starting && !s.readySig.Get() {
				rows = append(rows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6,
					Padding: core.Symmetric(4, 8)}, Children: []core.Node{
					ui.Spinner{Size: 11},
					ui.Text(T("正在启动 agent…"), 11, ui.Regular, colors.Muted),
				}})
			}
			rows = append(rows, composerPanelTitle(cx, T("启动参数")))
			param := func(label, value string) core.Node {
				return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignStart, Gap: 8, Padding: core.Symmetric(2, 8)},
					Children: []core.Node{
						core.Text{Content: label, Style: core.Style{FontSize: 10.5, Width: core.Pt(64), FlexShrink: 0},
							StyleFunc: ui.Colored(colors.Faint)},
						core.Text{Content: value, MaxLines: 2, EllipsizeMode: core.EllipsizeMiddle, Selectable: core.SelectableOn,
							Style: core.Style{FontFamily: ui.Mono, FontSize: 10.5, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)},
							StyleFunc: ui.Colored(colors.Muted)},
					}}
			}
			cmd, args := "", ""
			if preset != nil {
				cmd, args = preset.Command, strings.Join(preset.Args, " ")
			}
			sessionID := s.acpSID
			if sessionID == "" {
				sessionID = T("（还没有建立）")
			}
			rows = append(rows,
				param(T("命令"), firstNonEmpty(cmd, "—")),
				param(T("参数"), firstNonEmpty(args, "—")),
				param(T("工作目录"), s.WS),
				param(T("会话"), sessionID),
			)
			if cmds := s.acpCommands.Get(); len(cmds) > 0 {
				rows = append(rows, composerDivider(cx), composerPanelTitle(cx, T("命令（插入输入框）")))
				for _, c := range cmds {
					cmd := c
					rows = append(rows, composerRow(cx, lucide.Command, "/"+cmd.Name, cmd.Description, false, false, func() {
						draft := s.draft.GetUntracked()
						if draft != "" && !strings.HasSuffix(draft, " ") && !strings.HasSuffix(draft, "\n") {
							draft += " "
						}
						s.draft.Set(draft + "/" + cmd.Name + " ")
						s.acpModeOpen.Set(false)
					}))
				}
			}
			rows = append(rows, composerDivider(cx), core.View{Style: core.Style{Direction: core.Row, Gap: 6, Padding: core.Symmetric(2, 0)},
				Children: []core.Node{
					ui.Button{Text: T("重连"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "acp-reconnect",
						OnPress: func() { s.acpModeOpen.Set(false); a.reconnectACP(s) }},
					ui.Button{Text: T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
						OnPress: func() { s.acpModeOpen.Set(false) }},
				}})
			return core.View{Style: core.Style{Gap: 1}, Children: rows}
		}, "acp-info-menu")
	})
}

// acpModeLabel maps a mode id to the name the agent gave it.
func acpModeLabel(modes []acpMode, id string) string {
	for _, m := range modes {
		if m.ID == id && m.Name != "" {
			return m.Name
		}
	}
	return id
}

// setACPMode switches the running agent to another operating mode.
func (a *app) setACPMode(s *session, modeID string) {
	if s == nil || s.acp == nil || s.acpSID == "" || modeID == "" {
		return
	}
	s.acpModeOpen.Set(false)
	if s.acpMode.Get() == modeID {
		return
	}
	c, sid := s.acp, s.acpSID
	go func() {
		err := c.setMode(sid, modeID)
		a.cx.Post(func() {
			if err != nil {
				a.toast(ui.ToastError, "切换模式失败", err.Error())
				return
			}
			s.acpMode.Set(modeID)
		})
	}()
}

// askACPPermission turns an agent's permission request into the app's
// select dialog and waits for the answer, on the agent's reader goroutine.
func (a *app) askACPPermission(s *session, req acpPermission) string {
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
	a.cx.Post(func() {
		s.acpReply = func(name string) {
			select {
			case answer <- name:
			default:
			}
		}
		s.ask.Set(&extensionAsk{ID: "acp", Method: "select", Title: "工具权限：" + req.Title,
			Message: "允许这次工具调用吗？", Options: names})
	})
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
	case <-time.After(2 * time.Minute):
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

// acpOpenDialog shows the preset picker.
func (a *app) acpOpenDialog() {
	a.acpOpen.Set(true)
}

// acpDialog lists the presets.
func (a *app) acpDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		def := ""
		if ws := a.activeWorkspace(); ws != nil {
			def = ws.ACPPreset
		}
		var rows []core.Node
		for _, p := range a.acpPresetList() {
			preset := p
			rows = append(rows, core.View{
				OnPress: func(core.PressEvent) {
					a.acpOpen.Set(false)
					if ws := a.activeWorkspace(); ws != nil {
						a.newACPSession(ws, preset)
					}
				},
				Role: core.RoleButton, Label: preset.Name, TestID: "acp-preset-" + preset.ID,
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, MinHeight: core.Pt(40),
						Padding: core.Symmetric(4, 8), CornerRadius: 7, Hover: &core.Style{Background: colors.Hover()}}
				},
				Children: []core.Node{
					ui.Icon(lucide.Bot, 14, colors.Muted),
					core.View{Style: core.Style{FlexGrow: 1, Gap: 1}, Children: []core.Node{
						core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5}, Children: []core.Node{
							core.Text{Content: preset.Name, Style: core.Style{FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
							core.Show{When: func() bool { return preset.ID == def }, Then: func(*core.Scope) core.Node {
								return ui.Icon(lucide.Star, 10, colors.Accent)
							}},
						}},
						core.Text{Content: preset.Command + " " + strings.Join(preset.Args, " "), MaxLines: 1,
							EllipsizeMode: core.EllipsizeMiddle, Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5},
							StyleFunc: ui.Colored(colors.Faint)},
					}},
				},
			})
		}
		return ui.Dialog{
			Open:         a.acpOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.acpOpen.Set(open) },
			Title:        "新建 ACP 会话",
			TestID:       "acp-dialog",
			Style:        core.Style{Width: core.Pt(520)},
			Children:     []core.Node{core.View{Style: core.Style{Gap: 4}, Children: rows}},
			Footer: []core.Node{
				core.Show{When: func() bool { return def != "" }, Then: func(*core.Scope) core.Node {
					return ui.Button{Text: "清除默认", Variant: ui.ButtonGhost, Size: ui.SizeSmall,
						OnPress: func() { a.clearACPPreset(a.activeWorkspace()) }}
				}},
				ui.Button{Text: "打开预设目录", Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: a.openACPDir},
				ui.Button{Text: "取消", Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.acpOpen.Set(false) }},
			},
		}
	})
}
