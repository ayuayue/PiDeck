//go:build !js && !android && !ios

package workbench

// The phone server and its network channels. The desktop app can expose
// its projects and sessions to the mobile build over HTTP; a token guards
// every request. The same page reports the addresses the phone can use on
// the LAN, over Tailscale or over EasyTier.

import (
	"net/http"
	"net/url"
	"strings"
	"time"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/remotewire"
)

// handleAgents lists the ways of working a new session can start with.
func (h *remoteHost) handleAgents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	out := remotewire.Agents{Agents: []remotewire.Agent{}}
	ok := h.app.withUI(func() {
		for _, p := range h.app.agentList() {
			out.Agents = append(out.Agents, remotewire.Agent{ID: p.ID, Name: apptext.T(p.Name), Description: apptext.T(p.Description)})
		}
	})
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	writeRemoteJSON(w, http.StatusOK, out)
}

// handleTasks lists the cron tasks with when they ran last and when they
// fire next, so the phone can say both without a cron parser.
func (h *remoteHost) handleTasks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	out := remotewire.Tasks{Tasks: []remotewire.Task{}}
	ok := h.app.withUI(func() {
		now := time.Now()
		newest := map[string]string{}
		for _, run := range h.app.taskRunList() {
			if run.SessionID == "" {
				continue
			}
			if _, seen := newest[run.TaskID]; seen {
				continue
			}
			newest[run.TaskID] = run.SessionID
		}
		for _, t := range h.app.taskList() {
			item := remotewire.Task{ID: t.ID, Name: t.Name, Prompt: t.Prompt, Project: t.Project, Cron: t.Cron,
				Backend: t.Backend, Agent: t.Persona, Enabled: t.Enabled, LastStatus: t.LastStatus,
				LastRunAt: remoteMillis(t.LastRunAt), SessionID: newest[t.ID]}
			if next := taskNextRun(t, now); !next.IsZero() {
				item.NextRunAt = next.UnixMilli()
			}
			out.Tasks = append(out.Tasks, item)
		}
	})
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	writeRemoteJSON(w, http.StatusOK, out)
}

// remoteMillis is a time as the phone reads it, 0 when unset.
func remoteMillis(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

// handleTaskAction switches one task on or off, or runs it now.
func (h *remoteHost) handleTaskAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/tasks/")
	parts := strings.SplitN(rest, "/", 2)
	id, err := url.PathUnescape(parts[0])
	if err != nil || id == "" {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "缺少任务 ID"})
		return
	}
	action := ""
	if len(parts) == 2 {
		action = strings.Trim(parts[1], "/")
	}
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	switch action {
	case "toggle":
		if err := decodeRemoteBody(r, &body); err != nil || body.Enabled == nil {
			writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "要说明是开启还是关闭"})
			return
		}
	case "run":
	default:
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "没有这个操作"})
		return
	}
	ok := h.app.withUI(func() {
		if action == "toggle" {
			h.app.toggleTask(id, *body.Enabled)
			return
		}
		h.app.runTaskNow(id)
	})
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	writeRemoteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleFavorites lists the answers and sessions in the desktop's
// favorites.
func (h *remoteHost) handleFavorites(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	out := remotewire.Favorites{Favorites: []remotewire.Favorite{}}
	ok := h.app.withUI(func() {
		for _, e := range h.app.favoriteList() {
			out.Favorites = append(out.Favorites, remotewire.Favorite{ID: e.ID, Kind: e.Kind, SessionID: e.SessionID,
				SessionTitle: e.SessionTitle, Project: e.Project, Prompt: e.Prompt, Text: e.Text,
				CreatedAt: remoteMillis(e.CreatedAt)})
		}
	})
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	writeRemoteJSON(w, http.StatusOK, out)
}
