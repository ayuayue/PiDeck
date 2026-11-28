//go:build !js && !android && !ios

package workbench

import (
	"sort"
	"strings"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

const sessionManagerPageSize = 20

// sessionManager holds only the dialog's choices. Sessions and archive state
// remain owned by the workspace lists and config, including while a batch runs.
type sessionManager struct {
	open      *core.Signal[bool]
	workspace *core.Signal[*workspace]
	archived  *core.Signal[bool]
	query     *core.Signal[string]
	agent     *core.Signal[string]
	page      *core.Signal[int]
	selected  *core.Signal[map[string]bool]
	busy      *core.Signal[bool]
	confirm   *core.Signal[bool]
	message   *core.Signal[string]
	pending   []*session
}

func newSessionManager(cx *core.Scope) *sessionManager {
	return &sessionManager{
		open: core.NewSignal(cx, false), workspace: core.NewSignal(cx, (*workspace)(nil)),
		archived: core.NewSignal(cx, false), query: core.NewSignal(cx, ""), agent: core.NewSignal(cx, ""),
		page: core.NewSignal(cx, 1), selected: core.NewSignalFunc(cx, map[string]bool{}, nil),
		busy: core.NewSignal(cx, false), confirm: core.NewSignal(cx, false), message: core.NewSignal(cx, ""),
	}
}

func (a *app) sessionManagerWorkspace(ws *workspace) *workspace {
	if ws != nil {
		return ws
	}
	if a.railTab.GetUntracked() == railTabChat {
		return a.chatWorkspace()
	}
	if ws := a.activeWorkspace(); ws != nil {
		return ws
	}
	return a.chatWorkspace()
}

func (a *app) openSessionManager(ws *workspace, archived bool) {
	m := a.sessionManager
	if m.busy.GetUntracked() {
		return
	}
	m.workspace.Set(a.sessionManagerWorkspace(ws))
	m.archived.Set(archived)
	m.query.Set("")
	m.agent.Set("")
	a.resetSessionManagerSelection()
	m.open.Set(true)
	a.refreshManagedSessions()
}

func (a *app) openChatSessionManager(archived bool) {
	if ws := a.ensureChatWorkspace(); ws != nil {
		a.openSessionManager(ws, archived)
	}
}

func (a *app) refreshManagedSessions() {
	m := a.sessionManager
	if m.busy.GetUntracked() || m.confirm.GetUntracked() {
		return
	}
	if ws := m.workspace.GetUntracked(); ws != nil {
		ws.piLoaded = false
		a.scanProject(ws)
	}
}

func (a *app) closeSessionManager() {
	m := a.sessionManager
	if !m.busy.GetUntracked() {
		m.open.Set(false)
		m.confirm.Set(false)
		m.pending = nil
	}
}

func (a *app) resetSessionManagerSelection() {
	m := a.sessionManager
	m.page.Set(1)
	m.selected.Set(map[string]bool{})
	m.message.Set("")
	m.confirm.Set(false)
	m.pending = nil
}

func (a *app) setSessionManagerQuery(value string) {
	if m := a.sessionManager; !m.busy.GetUntracked() && !m.confirm.GetUntracked() {
		m.query.Set(value)
		a.resetSessionManagerSelection()
	}
}

func (a *app) setSessionManagerAgent(value string) {
	if m := a.sessionManager; !m.busy.GetUntracked() && !m.confirm.GetUntracked() {
		m.agent.Set(value)
		a.resetSessionManagerSelection()
	}
}

func (a *app) setSessionManagerArchived(archived bool) {
	if m := a.sessionManager; !m.busy.GetUntracked() && !m.confirm.GetUntracked() {
		m.archived.Set(archived)
		a.resetSessionManagerSelection()
	}
}

func managedAgentKey(s *session) string {
	if s.backend == "acp" {
		return "acp:" + s.acpPreset
	}
	return "pi"
}

// managedProjectSessions includes hidden archives and children, independent of
// the sidebar's tree window, and never counts the same ID twice.
func managedProjectSessions(ws *workspace) []*session {
	if ws == nil {
		return nil
	}
	seen := map[string]bool{}
	var out []*session
	for _, list := range [][]*session{ws.Sessions.Get(), ws.Pi.Get()} {
		for _, s := range list {
			if s != nil && !seen[s.ID] {
				seen[s.ID] = true
				out = append(out, s)
			}
		}
	}
	return out
}

func (a *app) managedSessions() []*session {
	m := a.sessionManager
	a.archiveRev.Get()
	archived, agent := m.archived.Get(), m.agent.Get()
	query := strings.ToLower(strings.TrimSpace(m.query.Get()))
	var out []*session
	for _, s := range managedProjectSessions(m.workspace.Get()) {
		if a.sessionArchived(s.ID) != archived || (agent != "" && managedAgentKey(s) != agent) {
			continue
		}
		if query != "" && !strings.Contains(strings.ToLower(s.title.Get()+" "+s.ID), query) {
			continue
		}
		out = append(out, s)
	}
	sort.SliceStable(out, func(i, j int) bool {
		ti, tj := out[i].updated.Get(), out[j].updated.Get()
		if ti.Equal(tj) {
			return out[i].ID < out[j].ID
		}
		return ti.After(tj)
	})
	return out
}

func managedSessionPage(rows []*session, page int) ([]*session, int, int) {
	pages := max(1, (len(rows)+sessionManagerPageSize-1)/sessionManagerPageSize)
	page = max(1, min(page, pages))
	start := (page - 1) * sessionManagerPageSize
	return rows[start:min(start+sessionManagerPageSize, len(rows))], page, pages
}

func (a *app) toggleManagedSession(id string, checked bool) {
	m := a.sessionManager
	if m.busy.GetUntracked() || m.confirm.GetUntracked() {
		return
	}
	next := make(map[string]bool, len(m.selected.GetUntracked())+1)
	for key, selected := range m.selected.GetUntracked() {
		if selected && key != id {
			next[key] = true
		}
	}
	if checked {
		next[id] = true
	}
	m.selected.Set(next)
	m.message.Set("")
}

func (a *app) selectManagedPage(checked bool) {
	m := a.sessionManager
	rows, _, _ := managedSessionPage(a.managedSessions(), m.page.GetUntracked())
	for _, s := range rows {
		a.toggleManagedSession(s.ID, checked)
	}
}

func (a *app) pickedManagedSessions() []*session {
	selected := a.sessionManager.selected.Get()
	var out []*session
	for _, s := range a.managedSessions() {
		if selected[s.ID] {
			out = append(out, s)
		}
	}
	return out
}

func (a *app) archiveManagedSessions(archived bool) {
	m := a.sessionManager
	if m.busy.GetUntracked() || m.confirm.GetUntracked() {
		return
	}
	rows := a.pickedManagedSessions()
	if len(rows) == 0 {
		return
	}
	picked := make(map[string]bool, len(rows))
	for _, s := range rows {
		picked[s.ID] = true
	}
	next := make([]string, 0, len(a.cfg.Archived)+len(rows))
	for _, id := range a.cfg.Archived {
		if !picked[id] {
			next = append(next, id)
		}
	}
	if archived {
		for _, s := range rows {
			next = append(next, s.ID)
		}
	}
	a.cfg.Archived = next
	if a.st != nil {
		a.st.change(func(c *config) { c.Archived = append([]string(nil), next...) })
		a.saveConfigAsync()
	}
	a.archiveRev.Update(func(n int) int { return n + 1 })
	a.resetSessionManagerSelection()
	if archived {
		m.message.Set(apptext.T("已归档 %d 个会话", len(rows)))
	} else {
		m.message.Set(apptext.T("已还原 %d 个会话", len(rows)))
	}
}

func (a *app) canDeleteManagedSessions() bool {
	rows := a.pickedManagedSessions()
	if len(rows) == 0 {
		return false
	}
	for _, s := range rows {
		if s.External || s.deleting || a.byID[s.ID] != s {
			return false
		}
	}
	return true
}

func (a *app) askDeleteManagedSessions() {
	m := a.sessionManager
	if m.busy.GetUntracked() || m.confirm.GetUntracked() || !a.canDeleteManagedSessions() {
		return
	}
	m.pending = append([]*session(nil), a.pickedManagedSessions()...)
	m.confirm.Set(true)
	m.message.Set("")
}

// The confirmed snapshot is processed in order through the single-session
// deletion path: stop the agent, wait for writes, then move its file to trash.
func (a *app) deleteManagedSessions() {
	m := a.sessionManager
	if !m.confirm.GetUntracked() || m.busy.GetUntracked() || len(m.pending) == 0 {
		return
	}
	rows := append([]*session(nil), m.pending...)
	m.confirm.Set(false)
	m.busy.Set(true)
	deleted, failed := 0, 0
	var next func(int)
	next = func(index int) {
		if index == len(rows) {
			m.busy.Set(false)
			m.pending = nil
			m.message.Set(apptext.T("已删除 %d 个会话，%d 个失败", deleted, failed))
			return
		}
		m.message.Set(apptext.T("正在删除 %d/%d…", index+1, len(rows)))
		s := rows[index]
		a.removeSession(s, func(err error) {
			if err != nil {
				failed++
				a.toast(ui.ToastError, apptext.T("删除失败"), err.Error())
			} else {
				deleted++
				// A successful removal alone clears its selection; failed rows
				// stay selected so the user can retry without guessing.
				selected := make(map[string]bool)
				for id, on := range m.selected.GetUntracked() {
					if on && id != s.ID {
						selected[id] = true
					}
				}
				m.selected.Set(selected)
			}
			next(index + 1)
		})
	}
	next(0)
}
