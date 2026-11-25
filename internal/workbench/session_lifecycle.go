//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// Lifecycle actions share their guards and confirmations across the palette,
// rail and tabs. Closing a tab deliberately remains a separate operation.
func (s *session) canControlAgent() bool {
	if s == nil {
		return false
	}
	s.status.Get()
	return !s.deleting && !s.agentStopping && !s.retryPending() && !s.historyLoading
}

func (s *session) hasAgent() bool {
	if s == nil {
		return false
	}
	return s.readySig.Get() || s.status.Get() == statusStarting || s.starting || s.warmPi != nil
}

func (a *app) askRestartAgent(s *session) {
	if !s.canControlAgent() {
		return
	}
	if s.busyNow() {
		a.askConfirm("重启 Agent", "这一轮还在运行，重启会中断它。", "重启", func() { a.restartAgent(s) })
		return
	}
	a.restartAgent(s)
}

func (a *app) askCloseAgent(s *session) {
	if !s.canControlAgent() || !s.hasAgent() {
		return
	}
	if s.busyNow() {
		a.askConfirm("关闭 Agent", "这一轮还在运行，关闭会中断它；记录和标签会保留。", "关闭", func() { a.closeAgent(s) })
		return
	}
	a.closeAgent(s)
}

func (a *app) restartAgent(s *session) {
	if s == nil || s.deleting || a.byID[s.ID] != s || s.agentStopping || s.retryPendingNow() {
		return
	}
	a.stopSessionAgent(s, true)
}

func (a *app) closeAgent(s *session) {
	if s == nil || s.deleting || a.byID[s.ID] != s {
		return
	}
	// A close requested while a restart is releasing the old process wins.
	if s.agentStopping {
		s.restarting = false
		s.agentClosed = true
		return
	}
	a.stopSessionAgent(s, false)
}

func (a *app) stopSessionAgent(s *session, restart bool) {
	s.agentClosed = !restart
	s.agentStopping = true
	s.restarting = restart
	s.historyGeneration++
	s.historyLoading = false
	s.waiters = nil
	s.sending.Set(nil)
	s.steering.Set(nil)
	s.goalPaused.Set(true)
	s.planActive = false
	a.cancelAsks(s)
	var stopped <-chan struct{}
	if s.backend == "acp" {
		stopped = a.detachACP(s)
	} else {
		s.piGeneration.Add(1)
		c, pending := s.engine, s.piStarting
		s.engine, s.piStarting = nil, nil
		s.starting = false
		a.cancelPiTurn(s)
		warm := s.warmPi
		s.warmPi = nil
		done := make(chan struct{})
		stopped = done
		go func() {
			defer close(done)
			if c == nil && pending != nil {
				c = <-pending
			}
			if c != nil {
				c.stop()
			}
			if warm != nil {
				warm.C.stop()
			}
		}()
	}
	s.readySig.Set(false)
	s.agentStopped = stopped
	s.notice.Set("")
	s.status.Set(statusWaiting)
	go func() {
		<-stopped
		a.cx.Post(func() {
			s.agentStopping = false
			s.agentStopped = nil
			s.status.Set(statusIdle)
			if s.restarting && !s.deleting && a.byID[s.ID] == s {
				s.restarting = false
				a.ensureEngine(s, nil)
			}
		})
	}()
}

// Preserve the partial answer before clearing the streaming overlay.
func (a *app) cancelPiTurn(s *session) {
	a.flushStream(s)
	text, thinking, tools := s.streamText.GetUntracked(), s.streamThinking.GetUntracked(), append([]toolRun(nil), s.liveTools.GetUntracked()...)
	s.turns.Update(func(ts []turn) []turn {
		for i := len(ts) - 1; i >= 0; i-- {
			if !ts[i].running() {
				continue
			}
			if text != "" || thinking != "" || len(tools) > 0 {
				for j := range tools {
					if tools[j].Status == chat.Running {
						tools[j].Status = chat.Cancelled
					}
				}
				ts[i].Steps = append(ts[i].Steps, turnStep{ID: stepID(&ts[i], ts[i].Msgs), Text: text, Thinking: thinking, Tools: tools})
			}
			ts[i].Status = chat.Cancelled
			ts[i].End = a.cx.Now()
			break
		}
		return ts
	})
	s.mu.Lock()
	s.liveText.Reset()
	s.liveThink.Reset()
	s.showReset()
	s.flushDue = false
	s.mu.Unlock()
	s.live = false
	s.runningSig.Set(false)
	s.streamText.Set("")
	s.streamThinking.Set("")
	s.liveTools.Set(nil)
	a.cancelAsks(s)
}

func (s *session) canReloadSession() bool {
	return s.canControlAgent() && !s.busy() && !s.starting &&
		(s.readySig.Get() || s.File != "" || (s.backend == "acp" && len(s.turns.Get()) > 0))
}

// reloadSession reads the backend's current projection without restarting it.
// ACP has no read-messages RPC: its bounded local archive is the projection.
func (a *app) reloadSession(s *session) {
	if !s.canReloadSession() {
		return
	}
	s.historyGeneration++
	generation := s.historyGeneration
	s.historyLoading = true
	s.status.Set(statusWaiting)
	c, file, target := s.engine, s.File, s.Target
	backend, archive := s.backend, filepath.Join(a.acpArchiveDir(), archiveName(s.ID))
	archiveSaved := s.acpArchiveTail
	go func() {
		var history []turn
		var items []todoItem
		var err error
		switch {
		case backend == "acp":
			if archiveSaved != nil {
				<-archiveSaved
			}
			var raw []byte
			raw, err = readPreviewBytes(archive, acpArchiveBytes)
			if err == nil {
				var arch acpArchive
				err = json.Unmarshal(raw, &arch)
				if err == nil && arch.ID != s.ID {
					err = fmt.Errorf("%s", apptext.T("找不到这个会话"))
				}
				history = arch.Turns
			}
		case c != nil:
			var out struct {
				Messages []piMessage `json:"messages"`
			}
			err = c.call(map[string]any{"type": "get_messages"}, &out, 30*time.Second)
			history, items = turnsFromMessages(out.Messages), todosFromMessages(out.Messages)
		default:
			var msgs []piMessage
			if target.remote() {
				msgs, err = targetHistoryMessages(target, file)
			} else {
				msgs, err = sessionFileMessages(file)
			}
			history, items = turnsFromMessages(msgs), todosFromMessages(msgs)
		}
		a.cx.Post(func() {
			if s.historyGeneration != generation || a.byID[s.ID] != s {
				return
			}
			s.historyLoading = false
			s.status.Set(statusIdle)
			if err != nil {
				a.toast(ui.ToastError, "重新读取会话失败", err.Error())
				return
			}
			s.turns.Set(history)
			if backend != "acp" {
				s.todos.Set(items)
			}
			s.loaded.Set(true)
			s.histFile = 0
		})
	}()
}
