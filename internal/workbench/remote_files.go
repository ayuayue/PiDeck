//go:build !js && !android && !ios

package workbench

// The phone server and its network channels. The desktop app can expose
// its projects and sessions to the mobile build over HTTP; a token guards
// every request. The same page reports the addresses the phone can use on
// the LAN, over Tailscale or over EasyTier.

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"time"

	"example.com/pideck-v2/internal/remotewire"
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

func projectWireKey(ws *workspace) string {
	if ws.Target.remote() {
		return trustKey(ws)
	}
	return ws.Path
}

func (a *app) workspaceByWireKey(project string) *workspace {
	for _, ws := range a.workspaces.GetUntracked() {
		if projectWireKey(ws) == project || (!ws.Target.remote() && samePath(ws.Path, project)) {
			return ws
		}
	}
	return nil
}

func (h *remoteHost) remoteWorkspaceFile(project, rel string) (workspaceFile, bool, bool) {
	var file workspaceFile
	var writable bool
	ok := h.app.withUI(func() {
		if ws := h.app.workspaceByWireKey(project); ws != nil {
			file = workspaceFile{target: ws.Target, root: ws.Path, rel: rel}
			writable = h.app.projectTrusted(ws)
		}
	})
	return file, writable, ok
}

// remoteFileMax is the largest file the phone may read.
const remoteFileMax = 512 << 10

// handleFiles lists a project's files for the phone, flat and sorted.
func (h *remoteHost) handleFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	file, _, ok := h.remoteWorkspaceFile(r.URL.Query().Get("project"), "")
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	if file.root == "" {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个项目"})
		return
	}
	var files []string
	if file.target.remote() {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		var err error
		files, err = file.target.targetFiles(ctx, file.root)
		if err != nil {
			writeRemoteJSON(w, http.StatusBadGateway, map[string]string{"error": fileEditorError(err)})
			return
		}
	} else {
		files = walkWorkspaceFiles(file.root)
		sort.Strings(files)
	}
	out := make([]remotewire.File, 0, len(files))
	for _, rel := range files {
		if _, ok := workspaceFileRel(rel); !ok {
			continue
		}
		var size int64
		if !file.target.remote() {
			if info, err := os.Lstat(filepath.Join(file.root, filepath.FromSlash(rel))); err == nil && info.Mode().IsRegular() {
				size = info.Size()
			} else {
				continue
			}
		}
		out = append(out, remotewire.File{Path: rel, Size: size})
	}
	writeRemoteJSON(w, http.StatusOK, map[string]any{"files": out})
}

// handleFile reads one file's text, refusing what the editor refuses too.
func (h *remoteHost) handleFile(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		h.handleFileWrite(w, r)
		return
	}
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	file, writable, ok := h.remoteWorkspaceFile(r.URL.Query().Get("project"), r.URL.Query().Get("path"))
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}
	if file.root == "" {
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个项目"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	data, err := file.read(ctx, remoteFileMax)
	if err != nil {
		writeFileProblem(w, err)
		return
	}
	writeRemoteJSON(w, http.StatusOK, remotewire.FileText{Path: file.rel, Text: string(data), Size: int64(len(data)),
		Revision: workspaceRevision(data), Writable: writable})
}

func fileWithin(root, rel string) (string, bool) {
	if _, ok := workspaceFileRel(rel); !ok || !filepath.IsLocal(filepath.FromSlash(rel)) {
		return "", false
	}
	return filepath.Join(root, filepath.FromSlash(rel)), true
}

func (h *remoteHost) handleFileWrite(w http.ResponseWriter, r *http.Request) {
	var req remotewire.FileWrite
	if err := decodeRemoteBodyLimit(r, &req, 6*remoteFileMax+8192); err != nil {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	file, writable, ok := h.remoteWorkspaceFile(req.Project, req.Path)
	switch {
	case !ok:
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
	case file.root == "":
		writeRemoteJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个项目"})
	case !writable:
		writeRemoteJSON(w, http.StatusForbidden, map[string]string{"error": "请先在电脑上信任这个项目。"})
	default:
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		revision, err := file.save(ctx, req.Revision, []byte(req.Text), remoteFileMax)
		if err != nil {
			writeFileProblem(w, err)
			return
		}
		writeRemoteJSON(w, http.StatusOK, remotewire.FileText{Path: file.rel, Size: int64(len(req.Text)), Revision: revision, Writable: true})
	}
}

func writeFileProblem(w http.ResponseWriter, err error) {
	status, message := http.StatusBadGateway, "无法读取或保存文件"
	switch {
	case errors.Is(err, os.ErrNotExist):
		status, message = http.StatusNotFound, "找不到这个文件"
	case errors.Is(err, errFilePath):
		status, message = http.StatusBadRequest, errFilePath.Error()
	case errors.Is(err, errFileTooLarge):
		status, message = http.StatusRequestEntityTooLarge, errFileTooLarge.Error()
	case errors.Is(err, errFileBinary):
		status, message = http.StatusUnsupportedMediaType, errFileBinary.Error()
	case errors.Is(err, errFileConflict):
		status, message = http.StatusConflict, errFileConflict.Error()
	}
	writeRemoteJSON(w, status, map[string]string{"error": message})
}
