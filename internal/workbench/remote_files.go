//go:build !js && !android && !ios

package workbench

// The phone server and its network channels. The desktop app can expose
// its projects and sessions to the mobile build over HTTP; a token guards
// every request. The same page reports the addresses the phone can use on
// the LAN, over Tailscale or over EasyTier.

import (
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"example.com/pideck-lite/internal/remotewire"
)

// handleGit reads a local project's repository for the phone.
func (h *remoteHost) handleGit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	project := r.URL.Query().Get("project")
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
	writeRemoteJSON(w, http.StatusOK, remoteGitOf(readGitState(localTarget, path, 1)))
}

// projectPath resolves a request's project to a local folder.
func (h *remoteHost) projectPath(project string) (string, bool) {
	var path string
	ok := h.app.withUI(func() {
		if ws := h.app.workspaceOf(project); ws != nil && !ws.Target.remote() {
			path = ws.Path
		}
	})
	return path, ok
}

// remoteFileMax is the largest file the phone may read.
const remoteFileMax = 512 << 10

// handleFiles lists a project's files for the phone, flat and sorted.
func (h *remoteHost) handleFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	root, ok := h.projectPath(r.URL.Query().Get("project"))
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	if root == "" {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个项目"})
		return
	}
	files := walkWorkspaceFiles(root)
	sort.Strings(files)
	out := make([]remotewire.File, 0, len(files))
	for _, rel := range files {
		var size int64
		if info, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel))); err == nil {
			size = info.Size()
		}
		out = append(out, remotewire.File{Path: rel, Size: size})
	}
	writeRemoteJSON(w, http.StatusOK, map[string]any{"files": out})
}

// handleFile reads one file's text, refusing what the editor refuses too.
func (h *remoteHost) handleFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	root, ok := h.projectPath(r.URL.Query().Get("project"))
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	if root == "" {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个项目"})
		return
	}
	rel := r.URL.Query().Get("path")
	full, ok := fileWithin(root, rel)
	if !ok {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "路径不在这个项目里"})
		return
	}
	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个文件"})
		return
	}
	if info.Size() > remoteFileMax {
		writeRemoteJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "文件太大，手机上只读 512 KB 以内的文件"})
		return
	}
	data, err := os.ReadFile(full)
	if err != nil {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个文件"})
		return
	}
	if bytes.IndexByte(data[:min(len(data), 8000)], 0) >= 0 {
		writeRemoteJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "这是二进制文件，不能当文本读"})
		return
	}
	writeRemoteJSON(w, http.StatusOK, map[string]any{"path": filepath.ToSlash(filepath.Clean(filepath.FromSlash(rel))), "text": string(data), "size": info.Size()})
}

// fileWithin resolves a request's relative path inside a root, refusing
// anything that leaves it.
func fileWithin(root, rel string) (string, bool) {
	rel = strings.TrimSpace(rel)
	if rel == "" {
		return "", false
	}
	clean := filepath.Clean(filepath.FromSlash(rel))
	if clean == "." || filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", false
	}
	full := filepath.Join(root, clean)
	if inside, err := filepath.Rel(root, full); err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
		return "", false
	}
	return full, true
}
