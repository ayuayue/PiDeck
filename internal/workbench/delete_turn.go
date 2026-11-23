//go:build !js && !android && !ios

package workbench

// Deleting a turn: the app appends pi's own context_edit records, so the
// model stops seeing the turn while the file keeps its lines.

import (
	"github.com/nsgo-dev/nsgo/ui"
)

// canDeleteTurn reports whether a turn can leave its session's context.
func canDeleteTurn(s *session, t turn) bool {
	return canBranchTurn(s, t) && t.sourceEntryID != ""
}

// askDeleteTurn confirms a deletion, which the file keeps but the model
// will not see again.
func (a *app) askDeleteTurn(s *session, t turn) {
	if !canDeleteTurn(s, t) {
		a.toast(ui.ToastInfo, "这个会话不能删除消息", "只有本机的 pi 会话能改写自己的上下文。")
		return
	}
	a.askConfirm("删除这一轮", "这一轮会从 pi 的上下文里去掉，后面的回合照旧；原文仍留在会话文件里。", "删除", func() {
		a.deleteTurn(s, t)
	})
}

// deleteTurn appends the records and shows the transcript they leave.
func (a *app) deleteTurn(s *session, t turn) {
	if s == nil || a.st == nil || a.byID[s.ID] != s || !canDeleteTurn(s, t) {
		return
	}
	st, file, target := a.st, s.File, t.sourceEntryID
	go func() {
		ids, err := st.turnEntryIDs(file, target)
		if err == nil {
			err = st.appendContextEdits(file, ids)
		}
		a.cx.Post(func() {
			if err != nil {
				a.toast(ui.ToastError, "删除失败", err.Error())
				return
			}
			a.reloadTranscript(s)
			// pi keeps the context it read when it started: restarting it is
			// what makes the deletion real for the next turn.
			a.restartAgent(s)
			a.toast(ui.ToastSuccess, "已删除这一轮", "")
		})
	}()
}

// reloadTranscript reads the session file again and replaces the transcript
// with the transcript it now projects.
func (a *app) reloadTranscript(s *session) {
	if s == nil || s.File == "" {
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
			if s.File != file || a.byID[s.ID] != s {
				return
			}
			a.fillHistory(s, history, items, true)
		})
	}()
}
