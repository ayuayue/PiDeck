//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"fmt"

	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) deleteSession(s *session) {
	if s == nil {
		return
	}
	if s.backend == "acp" {
		a.askConfirm("删除会话", "「"+s.title.GetUntracked()+"」会从侧栏消失，ACP 归档也会删除。", "删除", func() {
			a.deleteACPArchive(s.ID)
			a.forgetFork(s.ID)
			a.closeTab(s.ID)
			delete(a.byID, s.ID)
			for i, x := range a.all {
				if x == s {
					a.all = append(a.all[:i], a.all[i+1:]...)
					break
				}
			}
			if ws := a.workspaceOf(s.WS); ws != nil {
				ws.Sessions.Update(func(ss []*session) []*session {
					out := ss[:0]
					for _, x := range ss {
						if x != s {
							out = append(out, x)
						}
					}
					return out
				})
			}
			a.remember()
			a.emit(eventSessionDeleted, appEvent{Session: s, Data: map[string]string{"backend": s.backend}})
		})
		return
	}
	if s.External {
		a.toast(ui.ToastInfo, "这是 pi 自己的会话", "它的文件在 pi 的目录里，应用不删它；可以在文件管理器里处理。")
		a.revealSession(s)
		return
	}
	body := fmt.Sprintf("「%s」会从侧栏消失，文件移到数据目录的 trash 里，需要时可以手动找回。", s.title.GetUntracked())
	a.askConfirm("删除会话", body, "删除", func() { a.removeSession(s) })
}

// forgetFork drops a deleted session's fork links, its own and its
// children's.
func (a *app) forgetFork(id string) {
	if a.st == nil || id == "" {
		return
	}
	a.st.edit(func(c *config) {
		delete(c.ForkParents, id)
		for child, parent := range c.ForkParents {
			if parent == id {
				delete(c.ForkParents, child)
			}
		}
	})
	a.cfg = a.st.config()
}

// removeSession deletes a session's file and every trace of it, without
// asking: the phone's delete comes in already confirmed.
func (a *app) removeSession(s *session) {
	if s == nil || s.External {
		return
	}
	// The process holds the session file on Windows: close it, and let
	// it go before moving the file.
	if s.engine != nil {
		s.engine.stop()
		s.engine = nil
	}
	if a.st != nil {
		if err := a.st.deleteSession(s.File, s.ID); err != nil {
			a.toast(ui.ToastError, "删除失败", err.Error())
			return
		}
		a.st.edit(func(c *config) {
			delete(c.Titles, s.ID)
			delete(c.ForkParents, s.ID)
			for child, parent := range c.ForkParents {
				if parent == s.ID {
					delete(c.ForkParents, child)
				}
			}
		})
		a.cfg = a.st.config()
	}
	a.closeTab(s.ID)
	delete(a.byID, s.ID)
	for i, x := range a.all {
		if x == s {
			a.all = append(a.all[:i], a.all[i+1:]...)
			break
		}
	}
	if ws := a.workspaceOf(s.WS); ws != nil {
		ws.Sessions.Update(func(ss []*session) []*session {
			out := ss[:0]
			for _, x := range ss {
				if x != s {
					out = append(out, x)
				}
			}
			return out
		})
	}
	a.toast(ui.ToastSuccess, "已删除会话", "文件在数据目录的 trash 下")
	a.remember()
	a.emit(eventSessionDeleted, appEvent{Session: s, Data: map[string]string{"backend": s.backend}})
}
