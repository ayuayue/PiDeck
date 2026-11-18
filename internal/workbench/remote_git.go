//go:build !js && !android && !ios

package workbench

// The phone server and its network channels. The desktop app can expose
// its projects and sessions to the mobile build over HTTP; a token guards
// every request. The same page reports the addresses the phone can use on
// the LAN, over Tailscale or over EasyTier.

import (
	"net/http"
	"strings"
	"time"

	"example.com/pideck-lite/internal/viewkit"
)

// handleGitDiff reads one changed file's patch. Only paths the repository
// reports are accepted, so a request cannot walk outside the project.
func (h *remoteHost) handleGitDiff(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	project := r.URL.Query().Get("project")
	rel := r.URL.Query().Get("path")
	var path string
	ok := h.app.withUI(func() {
		if ws := h.app.workspaceOf(project); ws != nil && !ws.Target.remote() {
			path = ws.Path
		}
	})
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	if path == "" {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个项目"})
		return
	}
	st := readGitState(localTarget, path, 1)
	var file *gitFile
	for i := range st.Files {
		if st.Files[i].Path == rel {
			file = &st.Files[i]
			break
		}
	}
	if file == nil {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "没有这个改动"})
		return
	}
	var args []string
	switch {
	case file.Untracked:
		args = []string{"diff", "--no-index", "--no-color", "--", "/dev/null", file.Path}
	case file.staged():
		args = []string{"diff", "--cached", "--no-color", "--", file.Path}
	default:
		args = []string{"diff", "--no-color", "--", file.Path}
	}
	out, stderr, code, err := gitRun(localTarget, path, 40*time.Second, args...)
	if err != nil {
		writeRemoteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if code != 0 && strings.TrimSpace(out) == "" {
		writeRemoteJSON(w, http.StatusInternalServerError, map[string]string{"error": viewkit.FirstLine(stderr, 200)})
		return
	}
	const limit = 512 << 10
	if len(out) > limit {
		out = out[:limit] + "\n… 补丁过长，已截断"
	}
	writeRemoteJSON(w, http.StatusOK, map[string]string{"patch": out})
}

// handleGitStage stages or unstages one changed path.
func (h *remoteHost) handleGitStage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Project string `json:"project"`
		Path    string `json:"path"`
		Stage   bool   `json:"stage"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var path string
	ok := h.app.withUI(func() {
		if ws := h.app.workspaceOf(body.Project); ws != nil && !ws.Target.remote() {
			path = ws.Path
		}
	})
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	if path == "" {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个项目"})
		return
	}
	st := readGitState(localTarget, path, 1)
	known := false
	for _, f := range st.Files {
		if f.Path == body.Path {
			known = true
			break
		}
	}
	if !known {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "没有这个改动"})
		return
	}
	var args []string
	if body.Stage {
		args = []string{"add", "--", body.Path}
	} else {
		args = []string{"restore", "--staged", "--", body.Path}
	}
	_, stderr, code, err := gitRun(localTarget, path, 60*time.Second, args...)
	if err == nil && code != 0 && !body.Stage {
		// An unborn branch has no HEAD for restore; take it out of the
		// index instead, as the desktop does.
		_, stderr, code, err = gitRun(localTarget, path, 60*time.Second, "rm", "--cached", "-r", "-q", "--", body.Path)
	}
	if err != nil {
		writeRemoteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if code != 0 {
		writeRemoteJSON(w, http.StatusInternalServerError, map[string]string{"error": viewkit.FirstLine(stderr, 200)})
		return
	}
	writeRemoteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleGitCommit commits what is staged. It never discards anything, so
// it is safe to expose to the phone with the same token as the rest.
func (h *remoteHost) handleGitCommit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Project string `json:"project"`
		Message string `json:"message"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	msg := strings.TrimSpace(body.Message)
	switch {
	case msg == "":
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "提交说明不能为空"})
		return
	case len([]rune(msg)) > 500:
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "提交说明太长了"})
		return
	}
	var path string
	ok := h.app.withUI(func() {
		if ws := h.app.workspaceOf(body.Project); ws != nil && !ws.Target.remote() {
			path = ws.Path
		}
	})
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	if path == "" {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个项目"})
		return
	}
	_, stderr, code, err := gitRun(localTarget, path, 180*time.Second, "commit", "-m", msg)
	if err != nil {
		writeRemoteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if code != 0 {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": viewkit.FirstLine(stderr, 240)})
		return
	}
	writeRemoteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleGitCheckout switches to a local branch.
func (h *remoteHost) handleGitCheckout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Project string `json:"project"`
		Branch  string `json:"branch"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var path string
	ok := h.app.withUI(func() {
		if ws := h.app.workspaceOf(body.Project); ws != nil && !ws.Target.remote() {
			path = ws.Path
		}
	})
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	if path == "" {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个项目"})
		return
	}
	st := readGitState(localTarget, path, 1)
	known := false
	for _, b := range st.Branches {
		if b == body.Branch {
			known = true
			break
		}
	}
	if !known {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "没有这个分支"})
		return
	}
	if st.Branch == body.Branch {
		writeRemoteJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	_, stderr, code, err := gitRun(localTarget, path, 60*time.Second, "checkout", body.Branch)
	if err != nil {
		writeRemoteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if code != 0 {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": viewkit.FirstLine(stderr, 240)})
		return
	}
	writeRemoteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleGitSync fetches, pulls or pushes, whichever the phone asked for.
func (h *remoteHost) handleGitSync(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Project string `json:"project"`
		Action  string `json:"action"`
	}
	if err := decodeRemoteBody(r, &body); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var args []string
	switch body.Action {
	case "fetch":
		args = []string{"fetch", "--all", "--prune"}
	case "pull":
		args = []string{"pull"}
	case "push":
		args = []string{"push"}
	default:
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "不认识的同步动作"})
		return
	}
	var path string
	ok := h.app.withUI(func() {
		if ws := h.app.workspaceOf(body.Project); ws != nil && !ws.Target.remote() {
			path = ws.Path
		}
	})
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	if path == "" {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个项目"})
		return
	}
	_, stderr, code, err := gitRun(localTarget, path, 180*time.Second, args...)
	if err != nil {
		writeRemoteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if code != 0 {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": viewkit.FirstLine(stderr, 240)})
		return
	}
	writeRemoteJSON(w, http.StatusOK, map[string]any{"ok": true})
}
