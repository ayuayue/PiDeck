package main

// ACP sessions: an external agent CLI in place of pi. Updates are
// projected into the same turns, steps and tool runs the transcript
// already draws, so the UI does not need a second timeline.

import (
	"fmt"
	"strings"
	"time"

	"github.com/oneo-me/nsgo/base"
	"github.com/oneo-me/nsgo/core"
	"github.com/oneo-me/nsgo/icons/lucide"
	"github.com/oneo-me/nsgo/ui"
	"github.com/oneo-me/nsgo/ui/chat"
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
	ws.Sessions.Update(func(ss []*session) []*session { return append([]*session{s}, ss...) })
	a.selectSession(s)
	return s
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
		func(p acpPermission) string { return a.askACPPermission(s, p) })
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
	if s.acpSID != "" {
		if c.loadSession(s.acpSID, s.WS) == nil {
			sid = s.acpSID
		}
	}
	if sid == "" {
		var err error
		sid, err = c.newSession(s.WS)
		if err != nil {
			c.stop()
			a.cx.Post(func() { a.failSession(s, "ACP 建会话失败："+err.Error()) })
			return
		}
	}
	a.cx.Post(func() {
		s.acp = c
		s.acpSID = sid
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
	case "tool_call":
		run := toolRun{CallID: u.ToolID, Name: u.Title, Action: "工具", Detail: u.Title, Status: chat.Running}
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
		a.updateACPTool(s, toolRun{CallID: u.ToolID, Name: u.Title, Output: u.Text, Status: status}, false)
	}
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

// askACPPermission turns an agent's permission request into the app's
// select dialog and waits for the answer, on the agent's reader goroutine.
func (a *app) askACPPermission(s *session, req acpPermission) string {
	if len(req.Options) == 0 {
		return ""
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
				return o.ID
			}
		}
		return ""
	case <-time.After(2 * time.Minute):
		return ""
	}
}

// acpOpenDialog shows the preset picker.
func (a *app) acpOpenDialog() {
	a.acpOpen.Set(true)
}

// acpDialog lists the presets.
func (a *app) acpDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
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
						core.Text{Content: preset.Name, Style: core.Style{FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
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
				ui.Button{Text: "打开预设目录", Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: a.openACPDir},
				ui.Button{Text: "取消", Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.acpOpen.Set(false) }},
			},
		}
	})
}
