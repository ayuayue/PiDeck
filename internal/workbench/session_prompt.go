//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"encoding/base64"
	"fmt"
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// planPrompt wraps a request so pi plans before it edits.
func planPrompt(text string) string {
	return apptext.T("请先不要改任何文件。先给出一个可执行的计划：") + "\n" +
		apptext.T("1. 分步骤说明要改什么、改哪些文件；") + "\n" +
		apptext.T("2. 每步的验证方式；") + "\n" +
		apptext.T("3. 可能的风险与回滚。") + "\n" +
		apptext.T("等我确认后再执行。") + "\n" + "\n" + text
}

// piPlanModeMarker selects PiDeck's plan-mode extension. The extension strips
// it before the model sees the message and switches pi to read-only tools.
const piPlanModeMarker = "__PI_DECK_PLAN_MODE__"

// planRequest picks the extension's marker when it is installed, and the
// plain text instructions otherwise.
func (a *app) planRequest(text string) string {
	if a.hasBundledExtension("pi-deck-plan-mode.ts") {
		return piPlanModeMarker + "\n" + text
	}
	return planPrompt(text)
}

// submitTurn starts a turn, asking for a plan when plan is true.
func (a *app) submitTurn(s *session, text string, images []remotewire.Image, plan bool) {
	if s.deleting || s.agentStopping || s.historyLoading || a.byID[s.ID] != s {
		return
	}
	if ws := a.workspaceFor(s.Target, s.WS); ws != nil && !a.projectTrusted(ws) {
		a.askTrust(ws, func() { a.submitTurn(s, text, images, plan) })
		return
	}
	original := text
	if p := a.agentByID(s.personaID); p != nil {
		text = personaPrompt(p.Prompt, text)
	}
	if plan {
		text = a.planRequest(text)
	}
	goal := modeOn(s, modeGoal)
	if goal {
		s.goalRounds = max(1, s.goalRounds)
		s.goalPaused.Set(false)
		if strings.TrimSpace(original) != "" {
			s.goalText = original
		}
		text = goalPrompt(text)
	}
	sourcePrompt := text
	if plan {
		sourcePrompt = strings.TrimSpace(strings.TrimPrefix(sourcePrompt, piPlanModeMarker))
	}
	a.cx.Batch(func() {
		if s.title.GetUntracked() == "新会话" || s.title.GetUntracked() == "" || s.title.GetUntracked() == "未命名会话" {
			name := viewkit.FirstLine(original, 28)
			if name == "" {
				name = "图片消息"
			}
			s.title.Set(name)
			if a.st != nil {
				a.st.edit(func(c *config) { c.Titles[s.ID] = name })
			}
		}
		turnID := fmt.Sprintf("t%d", a.cx.Now().UnixNano())
		s.turns.Update(func(ts []turn) []turn {
			return append(ts, turn{ID: turnID, sourcePrompt: sourcePrompt, Prompt: original, Images: images, Status: chat.Running, Start: a.cx.Now(),
				Model: s.model.GetUntracked().ID, Plan: plan, Goal: goal})
		})
		s.status.Set(statusStarting)
		s.runningSig.Set(true)
		s.notice.Set("")
		s.conversation.JumpToLatest()
		a.touch(s)
		if s.backend == "acp" {
			a.ensureEngine(s, func() { a.acpPrompt(s, turnID, text, images) })
		} else {
			a.ensureEngine(s, func() { a.prompt(s, turnID, text, images) })
		}
	})
	a.emit(eventTurnStart, appEvent{Session: s, Data: map[string]string{
		"plan": fmt.Sprintf("%t", plan), "backend": s.backend, "prompt": viewkit.FirstLine(original, 200),
	}})
}

// steer sends a message into the running turn, waiting for pi if it is
// still starting.
func (a *app) steer(s *session, text string, images []remotewire.Image) {
	if s.engine == nil {
		a.ensureEngine(s, func() { a.steer(s, text, images) })
		return
	}
	a.cx.Batch(func() {
		s.turns.Update(func(ts []turn) []turn {
			for i := len(ts) - 1; i >= 0; i-- {
				if ts[i].running() {
					ts[i].Steps = append(ts[i].Steps, turnStep{ID: "steer-" + fmt.Sprint(len(ts[i].Steps)),
						Note: apptext.T("发送引导"), Text: text})
					break
				}
			}
			return ts
		})
	})
	go func(c *piClient, text string, images []remotewire.Image) {
		cmd := map[string]any{"type": "steer", "message": text}
		if imgs := encodeImages(images); imgs != nil {
			cmd["images"] = imgs
		}
		if err := c.call(cmd, nil, 30*time.Second); err != nil {
			a.cx.Post(func() { a.toast(ui.ToastError, "引导发送失败", err.Error()) })
		}
	}(s.engine, text, images)
}

// prompt sends a prompt command for a turn.
func (a *app) prompt(s *session, turnID, text string, images []remotewire.Image) {
	c := s.engine
	if c == nil {
		a.failTurn(s, turnID, "pi 没有就绪")
		return
	}
	cmd := map[string]any{"type": "prompt", "message": text}
	if imgs := encodeImages(images); imgs != nil {
		cmd["images"] = imgs
	}
	var resp struct {
		Disposition string `json:"disposition"`
	}
	go func() {
		err := c.call(cmd, &resp, 60*time.Second)
		a.cx.Post(func() {
			if s.engine != c {
				return
			}
			switch {
			case err != nil:
				a.failTurn(s, turnID, err.Error())
			case resp.Disposition == "handled":
				a.finishTurn(s, turnID, chat.Completed, "")
			default:
				s.status.Set(statusRunning)
			}
		})
	}()
}

// encodeImages is a prompt's image blocks.
func encodeImages(images []remotewire.Image) []map[string]any {
	if len(images) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(images))
	for _, img := range images {
		mime := img.MimeType
		if mime == "" {
			mime = "image/png"
		}
		out = append(out, map[string]any{"type": "image", "data": base64.StdEncoding.EncodeToString(img.Data), "mimeType": mime})
	}
	return out
}

// failTurn ends a turn with an error.
func (a *app) failTurn(s *session, turnID, why string) {
	a.cx.Batch(func() {
		s.status.Set(statusFailed)
		s.runningSig.Set(false)
		s.turns.Update(func(ts []turn) []turn {
			for i := range ts {
				if ts[i].ID == turnID {
					ts[i].Status = chat.Failed
					ts[i].Err = why
					ts[i].End = a.cx.Now()
				}
			}
			return ts
		})
	})
}

// finishTurn marks one turn done if it is still open.
func (a *app) finishTurn(s *session, turnID string, status chat.Status, errText string) {
	s.runningSig.Set(false)
	s.turns.Update(func(ts []turn) []turn {
		for i := range ts {
			if ts[i].ID == turnID && ts[i].running() {
				ts[i].Status = status
				ts[i].End = a.cx.Now()
				if errText != "" {
					ts[i].Err = errText
				}
			}
		}
		return ts
	})
	s.status.Set(statusIdle)
}

// stop aborts the run and clears anything queued behind it.
func (a *app) stop(s *session) {
	if s == nil {
		return
	}
	// A goal the user stops waits for them: it is not the agent failing.
	if modeOn(s, modeGoal) && s.goalPaused != nil {
		s.goalPaused.Set(true)
	}
	s.sending.Set(nil)
	// A question the run waits on is let go too: stopping means stopping.
	a.cancelAsks(s)
	if s.backend == "acp" {
		if !s.busyNow() {
			return
		}
		a.stopACPTurn(s, acpStopManual)
		return
	}
	if s.engine == nil {
		return
	}
	if !s.busyNow() {
		return
	}
	c := s.engine
	go func() {
		if err := c.call(map[string]any{"type": "clear_queue"}, nil, 10*time.Second); err != nil {
			// A session with nothing queued may refuse; abort still stands.
			_ = err
		}
		if err := c.call(map[string]any{"type": "abort"}, nil, 60*time.Second); err != nil {
			a.cx.Post(func() { a.toast(ui.ToastError, "停止失败", err.Error()) })
		}
		a.cx.Post(func() {
			s.steering.Set(nil)
		})
	}()
	s.status.Set(statusWaiting)
}

// compact asks pi to summarize the conversation.
func (a *app) compact(s *session) {
	a.compactWithInstructions(s, "")
}

// compactWithInstructions keeps the user's optional /compact guidance.
func (a *app) compactWithInstructions(s *session, instructions string) {
	if s == nil {
		return
	}
	if s.backend == "acp" {
		a.toast(ui.ToastInfo, "ACP 会话不支持压缩", "请在该 CLI 自己的界面里处理上下文。")
		return
	}
	a.ensureEngine(s, func() {
		if s.busyNow() || s.status.GetUntracked() == statusRunning || s.status.GetUntracked() == statusWaiting {
			a.toast(ui.ToastWarning, "先等这一轮结束", "运行中不能压缩上下文。")
			return
		}
		c := s.engine
		s.status.Set(statusWaiting)
		s.notice.Set("正在压缩上下文…")
		go func() {
			var res struct {
				TokensBefore   int `json:"tokensBefore"`
				EstimatedAfter int `json:"estimatedTokensAfter"`
			}
			cmd := map[string]any{"type": "compact"}
			if instructions != "" {
				cmd["customInstructions"] = instructions
			}
			err := c.call(cmd, &res, 180*time.Second)
			a.cx.Post(func() {
				s.notice.Set("")
				if s.status.GetUntracked() == statusWaiting {
					s.status.Set(statusIdle)
				}
				if err != nil {
					a.toast(ui.ToastError, "压缩失败", err.Error())
					return
				}
				a.toast(ui.ToastSuccess, "上下文已压缩", fmt.Sprintf("%s → %s tokens", viewkit.Tokens(res.TokensBefore), viewkit.Tokens(res.EstimatedAfter)))
				a.startStats(s)
			})
		}()
	})
}
