//go:build !js && !android && !ios

package workbench

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

func (a *app) deleteSession(s *session) {
	if s == nil {
		return
	}
	if s.External {
		a.toast(ui.ToastInfo, "这是 pi 自己的会话", "它的文件在 pi 的目录里，应用不删它；可以在文件管理器里处理。")
		a.revealSession(s)
		return
	}
	body := apptext.T("「%s」会从侧栏移除。会话文件会移到所在设备的数据目录的 trash。", s.title.GetUntracked())
	a.askConfirm("删除会话", body, "删除", func() {
		a.removeSession(s, func(err error) {
			if err != nil {
				a.toast(ui.ToastError, "删除失败", err.Error())
				return
			}
			a.toast(ui.ToastSuccess, "已删除会话", "文件在数据目录的 trash 下")
		})
	})
}

// removeSession waits for the agent's file handle to close before moving
// the file on its owning machine. The rail changes only after that succeeds.
func (a *app) removeSession(s *session, done func(error)) {
	if s == nil || s.External || a.st == nil || a.byID[s.ID] != s {
		done(errors.New(apptext.T("找不到这个会话")))
		return
	}
	if s.deleting {
		done(errors.New(apptext.T("正在删除会话…")))
		return
	}
	s.deleting = true
	s.waiters = nil
	if s.starting {
		s.deleteReady = func() {
			s.deleting = false
			a.removeSession(s, done)
		}
		return
	}
	a.cancelAsks(s)
	s.sending.Set(nil)
	s.restarting = false
	if turns := s.turns.GetUntracked(); len(turns) != 0 && turns[len(turns)-1].running() {
		a.finishTurn(s, turns[len(turns)-1].ID, chat.Cancelled, "")
	}
	engine, acp := s.engine, s.acp
	s.engine, s.acp = nil, nil
	s.acpGeneration++
	s.readySig.Set(false)
	s.status.Set(statusIdle)
	st, file, id, target := a.st, s.File, s.ID, s.Target
	archive := s.backend == "acp"
	if archive {
		file = filepath.Join(a.acpArchiveDir(), archiveName(id))
	}
	go func() {
		if engine != nil {
			engine.stop()
		}
		if acp != nil {
			acp.stop()
		}
		var err error
		if target.remote() && !archive && file != "" {
			ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
			_, err = target.trashSession(ctx, file)
			cancel()
		} else if file != "" {
			err = st.deleteSession(file, id)
		}
		a.cx.Post(func() {
			s.deleting = false
			if err == nil && a.byID[id] == s {
				a.finishSessionRemoval(s)
			}
			done(err)
		})
	}()
}

func (s *session) resumeDeletion() bool {
	if s.deleteReady == nil {
		return false
	}
	deleteReady := s.deleteReady
	s.deleteReady = nil
	deleteReady()
	return true
}

func (a *app) finishSessionRemoval(s *session) {
	a.st.edit(func(c *config) {
		delete(c.Titles, s.ID)
		delete(c.ForkParents, s.ID)
		delete(c.SessionPersonas, s.ID)
		for child, parent := range c.ForkParents {
			if parent == s.ID {
				delete(c.ForkParents, child)
			}
		}
	})
	a.cfg = a.st.config()
	a.closeTab(s.ID)
	a.forgetSessionOrganization(s.ID)
	a.forgetSessionDraft(s)
	delete(a.byID, s.ID)
	a.all = slices.DeleteFunc(a.all, func(other *session) bool { return other == s })
	if ws := a.workspaceFor(s.Target, s.WS); ws != nil {
		ws.Sessions.Update(func(list []*session) []*session {
			return slices.DeleteFunc(slices.Clone(list), func(other *session) bool { return other == s })
		})
	}
	a.remember()
	a.emit(eventSessionDeleted, appEvent{Session: s, Data: map[string]string{"backend": s.backend}})
}

func (t target) trashSession(ctx context.Context, file string) (string, error) {
	if !validTargetSessionFile(file) {
		return "", errFilePath
	}
	name := newSessionID() + ".jsonl"
	cmd, err := t.workspaceCommand(ctx, "/", targetSessionGuard+`
trash="$HOME/.pideck-v2/trash"
[ ! -L "$trash" ] && mkdir -p "$trash" || exit 43
mv "$file" "$trash/$3"`, file, name)
	if err != nil {
		return "", err
	}
	err = targetFileError(cmd.Run())
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	return name, err
}
