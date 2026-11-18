//go:build !js && !android && !ios

package workbench

// The phone server and its network channels. The desktop app can expose
// its projects and sessions to the mobile build over HTTP; a token guards
// every request. The same page reports the addresses the phone can use on
// the LAN, over Tailscale or over EasyTier.

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"example.com/pideck-lite/internal/apptext"
)

// handleProject adds or removes a project folder on the desktop.
func (h *remoteHost) handleProject(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Path   string `json:"path"`
		Remove bool   `json:"remove"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	path := strings.TrimSpace(body.Path)
	if path == "" {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "缺少文件夹路径"})
		return
	}
	if body.Remove {
		var failure error
		ok := h.app.withUI(func() {
			ws := h.app.workspaceOf(path)
			if ws == nil {
				failure = errors.New("找不到这个项目")
				return
			}
			h.app.removeWorkspaceNow(ws)
		})
		h.finishAction(w, ok, failure, map[string]any{"ok": true})
		return
	}
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "电脑上找不到这个文件夹"})
		return
	}
	var failure error
	ok := h.app.withUI(func() { h.app.addWorkspace(path) })
	h.finishAction(w, ok, failure, map[string]any{"ok": true, "name": filepath.Base(path)})
}

// handleCreateSession starts a session in one of the projects.
func (h *remoteHost) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Project string `json:"project"`
		Title   string `json:"title"`
		Agent   string `json:"agent"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	project := strings.TrimSpace(body.Project)
	agent := strings.TrimSpace(body.Agent)
	var id, title string
	var failure error
	ok := h.app.withUI(func() {
		ws := h.app.workspaceOf(project)
		if ws == nil {
			failure = errors.New("找不到这个项目")
			return
		}
		s := h.app.newSession(ws.Path)
		if s == nil {
			failure = errors.New("新建会话失败")
			return
		}
		if agent != "" {
			// An agent is the way of working the phone picked; a name the
			// desktop does not know leaves the session as it is.
			if persona := h.app.agentByID(agent); persona != nil {
				h.app.setPersona(s, persona.ID)
				if strings.TrimSpace(body.Title) == "" {
					s.title.Set(apptext.T(persona.Name))
					if h.app.st != nil {
						h.app.st.edit(func(c *config) { c.Titles[s.ID] = apptext.T(persona.Name) })
					}
				}
			}
		}
		if name := strings.TrimSpace(body.Title); name != "" {
			s.title.Set(name)
			if h.app.st != nil {
				h.app.st.edit(func(c *config) { c.Titles[s.ID] = name })
			}
		}
		id, title = s.ID, s.title.Get()
	})
	switch {
	case !ok:
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
	case failure != nil:
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": failure.Error()})
	default:
		writeRemoteJSON(w, http.StatusOK, map[string]string{"id": id, "title": title})
	}
}
