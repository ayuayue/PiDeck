//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"slices"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/sessionimport"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// importSession imports one session file the user picked and opens it. A
// pi file is copied as it is; another agent's log is converted by its
// source, and lands under the folder it ran in.
func (a *app) importSession(path string) {
	if a.st == nil {
		return
	}
	if sessionimport.SniffPi(sessionimport.ReadHead(path, 64<<10)) {
		meta, err := a.st.importSession(path)
		a.finishFileImport(meta, err)
		return
	}
	source, head := sessionimport.SourceForFile(path)
	if source == nil {
		a.toast(ui.ToastError, apptext.T("导入失败"), sessionimport.NoSourceForFile(head).Error())
		return
	}
	parsed, err := source.Read(path)
	if err != nil {
		a.toast(ui.ToastError, apptext.T("导入失败"), err.Error())
		return
	}
	cwd := a.importCwdFor(sessionimport.Candidate{Source: source.Key, Path: path, Cwd: parsed.Cwd})
	meta, err := a.st.writeFileImport(*source, path, parsed, cwd)
	a.finishFileImport(meta, err)
}

// finishFileImport puts an imported file's session in the rail and opens it.
func (a *app) finishFileImport(meta sessionMeta, err error) {
	if err != nil {
		a.toast(ui.ToastError, apptext.T("导入失败"), err.Error())
		return
	}
	a.addImportedSession(meta)
	if s := a.byID[meta.ID]; s != nil {
		a.selectSession(s)
	}
	a.toast(ui.ToastSuccess, apptext.T("已导入会话"), meta.Title)
}

// deleteSession moves a session out of the store.
// duplicateSession copies a session's file under a new id and opens the
// copy, so an experiment does not touch the original's history.
func (a *app) duplicateSession(s *session) {
	if s == nil || a.st == nil {
		return
	}
	if s.File == "" {
		a.toast(ui.ToastInfo, "这个会话还没有文件", "发一条消息后就能复制。")
		return
	}
	id := newSessionID()
	title := s.title.GetUntracked() + " 副本"
	src, st := s.File, a.st
	go func() {
		meta, err := st.duplicateSession(src, id, title)
		a.cx.Post(func() {
			if err != nil {
				a.toast(ui.ToastError, "复制会话失败", err.Error())
				return
			}
			ns := a.makeSession(meta, s.Target)
			if ws := a.workspaceOf(meta.Cwd); ws != nil {
				ws.Sessions.Update(func(ss []*session) []*session { return append([]*session{ns}, ss...) })
			}
			a.selectSession(ns)
			a.toast(ui.ToastSuccess, "已复制会话", title)
		})
	}()
}

// forkSession copies a session up to one turn into a new session and
// puts that turn's prompt back in the composer: the way to try another
// answer without losing the original history.
func (a *app) forkSession(s *session, turnID string) {
	a.branchFromTurn(s, turnID, false)
}

func canBranchTurn(s *session, t turn) bool {
	return s != nil && s.backend != "acp" && !s.Target.remote() && s.File != "" && !t.running() &&
		(strings.TrimSpace(t.Prompt) != "" || len(t.Images) > 0)
}

func (a *app) branchFromTurn(s *session, turnID string, send bool) {
	if s == nil || a.st == nil {
		return
	}
	if s.Target.remote() || s.backend == "acp" {
		a.toast(ui.ToastInfo, "远程会话暂不支持分叉", "现在只分叉本机会话。")
		return
	}
	if s.File == "" {
		a.toast(ui.ToastInfo, "这个会话还没有文件", "发一条消息后再分叉。")
		return
	}
	turns := s.turns.GetUntracked()
	idx := slices.IndexFunc(turns, func(t turn) bool { return t.ID == turnID })
	if idx < 0 || !canBranchTurn(s, turns[idx]) {
		return
	}
	if send {
		a.retryTurn(s, turns[idx])
		return
	}
	prompt := turns[idx]
	ordinal := 0
	for _, t := range turns[:idx] {
		if t.Prompt != "" || len(t.Images) > 0 || t.sourceEntryID != "" {
			ordinal++
		}
	}
	id := newSessionID()
	title := apptext.T("%s（分叉）", s.title.GetUntracked())
	src, st := s.File, a.st
	go func() {
		meta, source, err := st.branchSession(src, id, branchPoint{
			ordinal: ordinal, entryID: prompt.sourceEntryID, text: prompt.sourcePrompt,
		}, title)
		images := slices.Clone(prompt.Images)
		if len(images) == 0 {
			images = piBlockImages(source.blocks())
		}
		images = slices.DeleteFunc(images, func(img remotewire.Image) bool { return len(img.Data) == 0 })
		text := firstNonEmpty(prompt.Prompt, source.text())
		a.cx.Post(func() {
			if err != nil {
				a.toast(ui.ToastError, "分叉会话失败", err.Error())
				return
			}
			ns := a.makeSession(meta, s.Target)
			if ws := a.workspaceFor(s.Target, s.WS); ws != nil {
				ws.Sessions.Update(func(ss []*session) []*session { return append([]*session{ns}, ss...) })
			}
			st.change(func(c *config) {
				if c.ForkParents == nil {
					c.ForkParents = map[string]string{}
				}
				c.ForkParents[ns.ID] = s.ID
			})
			a.cfg = st.config()
			a.selectSession(ns)
			a.sessionCreated(ns, "fork")
			if send && (strings.TrimSpace(text) != "" || len(images) > 0) {
				a.submitTurn(ns, text, images, prompt.Plan)
				return
			}
			ns.draft.Set(text)
			ns.images.Set(images)
			a.toast(ui.ToastSuccess, "已分叉会话", "原提问已放回输入框，改完可以直接发。")
		})
	}()
}

// retryTurn answers a turn again on a fork. The fork shows at once — the
// rail gets it, the transcript holds a “重试中” spinner, and the session it
// came from is archived and its tab closed — so the wait for the copied
// file reads as progress instead of a chat that does nothing.
func (a *app) retryTurn(s *session, t turn) {
	if s == nil || a.st == nil || a.byID[s.ID] != s || !canBranchTurn(s, t) {
		return
	}
	turns := s.turns.GetUntracked()
	idx := slices.IndexFunc(turns, func(x turn) bool { return x.ID == t.ID })
	if idx < 0 {
		return
	}
	ordinal := 0
	for _, x := range turns[:idx] {
		if x.Prompt != "" || len(x.Images) > 0 || x.sourceEntryID != "" {
			ordinal++
		}
	}
	src, st := s.File, a.st
	id := newSessionID()
	title := apptext.T("%s（重试）", s.title.GetUntracked())
	ns := a.makeSession(sessionMeta{ID: id, Title: title, Cwd: s.WS, Updated: a.cx.Now()}, s.Target)
	ns.retrying.Set(true)
	ns.turns.Set([]turn{{ID: id + "-pending", Status: chat.Waiting, Start: a.cx.Now(), Noticed: apptext.T("重试中")}})
	if ws := a.workspaceFor(s.Target, s.WS); ws != nil {
		ws.Sessions.Update(func(ss []*session) []*session { return append([]*session{ns}, ss...) })
	}
	a.selectSession(ns)
	if a.setArchived(s.ID, true) {
		a.closeTab(s.ID)
		a.toast(ui.ToastInfo, apptext.T("已在新会话里重试"), apptext.T("原会话已归档，可在侧栏「显示已归档」找回。"))
	}
	st.change(func(c *config) {
		if c.ForkParents == nil {
			c.ForkParents = map[string]string{}
		}
		c.ForkParents[ns.ID] = s.ID
	})
	a.cfg = st.config()
	a.sessionCreated(ns, "fork")
	go func() {
		meta, source, err := st.branchSession(src, id, branchPoint{
			ordinal: ordinal, entryID: t.sourceEntryID, text: t.sourcePrompt,
		}, title)
		images := slices.Clone(t.Images)
		if len(images) == 0 {
			images = piBlockImages(source.blocks())
		}
		images = slices.DeleteFunc(images, func(img remotewire.Image) bool { return len(img.Data) == 0 })
		text := firstNonEmpty(t.Prompt, source.text())
		a.cx.Post(func() {
			if a.byID[id] != ns {
				return // closed while the copy ran
			}
			if err != nil {
				a.abandonRetry(s, ns, err)
				return
			}
			ns.File, ns.External = meta.File, false
			ns.retrying.Set(false)
			ns.turns.Set(nil)
			if !meta.Updated.IsZero() {
				ns.updated.Set(meta.Updated)
			}
			a.openSessionHistory(ns)
			if strings.TrimSpace(text) != "" || len(images) > 0 {
				a.submitTurn(ns, text, images, t.Plan)
			}
		})
	}()
}

// abandonRetry drops a fork that could not be written, brings back the
// session it came from and says why.
func (a *app) abandonRetry(from, ns *session, err error) {
	ns.retrying.Set(false)
	a.closeTab(ns.ID)
	delete(a.byID, ns.ID)
	a.all = slices.DeleteFunc(a.all, func(other *session) bool { return other == ns })
	if ws := a.workspaceFor(ns.Target, ns.WS); ws != nil {
		ws.Sessions.Update(func(list []*session) []*session {
			return slices.DeleteFunc(slices.Clone(list), func(other *session) bool { return other == ns })
		})
	}
	if from != nil && a.byID[from.ID] == from {
		a.setArchived(from.ID, false)
		a.selectSession(from)
	}
	a.toast(ui.ToastError, "重试失败", err.Error())
}
