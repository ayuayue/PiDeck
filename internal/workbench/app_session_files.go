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
	prompt := turns[idx]
	ordinal := 0
	for _, t := range turns[:idx] {
		if t.Prompt != "" || len(t.Images) > 0 || t.sourceEntryID != "" {
			ordinal++
		}
	}
	id := newSessionID()
	title := apptext.T("%s（分叉）", s.title.GetUntracked())
	if send {
		title = apptext.T("%s（重试）", s.title.GetUntracked())
	}
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
