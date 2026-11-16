//go:build !js && !android && !ios

package main

// Sharing a project list: the rail's projects as JSON, and adding the
// ones another machine's file names.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// projectExport is the file a project list travels in.
type projectExport struct {
	Version  int            `json:"version"`
	Projects []workspaceCfg `json:"projects"`
}

// projectExportJSON writes the rail's projects as a file's bytes.
func projectExportJSON(list []*workspace) ([]byte, error) {
	out := projectExport{Version: configVersion}
	for _, w := range list {
		if w == nil || w.Chat {
			continue
		}
		out.Projects = append(out.Projects, workspaceCfg{Path: w.Path, Name: w.Name, Target: w.Target.key(),
			Group: w.Group, Pinned: w.Pinned, Added: w.Added, ACPPreset: w.ACPPreset})
	}
	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

// parseProjectExport reads a file's bytes: an object with projects, or a
// bare array.
func parseProjectExport(raw []byte) ([]workspaceCfg, error) {
	var file projectExport
	if json.Unmarshal(raw, &file) != nil || len(file.Projects) == 0 {
		var list []workspaceCfg
		if json.Unmarshal(raw, &list) != nil || len(list) == 0 {
			return nil, fmt.Errorf("不是项目列表")
		}
		file.Projects = list
	}
	var out []workspaceCfg
	for _, w := range file.Projects {
		w.Path = strings.TrimSpace(w.Path)
		if w.Path == "" {
			continue
		}
		out = append(out, w)
		if len(out) >= 200 {
			break
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("列表里没有可用的项目")
	}
	return out, nil
}

// exportProjects writes the rail's projects under exports/.
func (a *app) exportProjects() {
	if a.st == nil {
		return
	}
	data, err := projectExportJSON(a.workspaces.GetUntracked())
	if err != nil {
		a.toast(ui.ToastError, "导出项目失败", err.Error())
		return
	}
	dir := filepath.Join(a.st.dir, "exports")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		a.toast(ui.ToastError, "导出项目失败", err.Error())
		return
	}
	path := filepath.Join(dir, "projects-"+time.Now().Format("20060102-150405")+".json")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		a.toast(ui.ToastError, "导出项目失败", err.Error())
		return
	}
	a.toastAction(ui.ToastSuccess, "已导出项目列表", path, "打开", func() { a.cx.OpenURL(fileURL(path), nil) })
}

// importProjects adds the projects a file names, skipping ones the rail
// already has.
func (a *app) importProjects(path string) {
	raw, err := os.ReadFile(path)
	if err != nil {
		a.toast(ui.ToastError, "导入项目失败", err.Error())
		return
	}
	if len(raw) > 1<<20 {
		a.toast(ui.ToastError, "导入项目失败", "文件太大，换一个 1 MB 以内的。")
		return
	}
	list, err := parseProjectExport(raw)
	if err != nil {
		a.toast(ui.ToastError, "导入项目失败", err.Error())
		return
	}
	added, skipped := 0, 0
	for _, w := range list {
		t := parseTarget(w.Target)
		if a.workspaceFor(t, cleanTargetPath(t, w.Path)) != nil {
			skipped++
			continue
		}
		a.addWorkspaceFor(t, w.Path, w.Name)
		ws := a.workspaceFor(t, cleanTargetPath(t, w.Path))
		if ws == nil {
			skipped++
			continue
		}
		ws.Group = w.Group
		ws.Pinned = w.Pinned
		added++
	}
	a.saveProjects()
	a.toast(ui.ToastSuccess, fmt.Sprintf("已导入 %d 个项目", added), fmt.Sprintf("跳过 %d 个已存在或无效的。", skipped))
}

// pickProjectsFile asks for a project list file and imports it.
func (a *app) pickProjectsFile() {
	a.cx.PickFiles(core.PickFilesOptions{Types: []string{".json"}}, func(files []core.File, err error) {
		switch {
		case err != nil:
			a.toast(ui.ToastError, "选择文件失败", err.Error())
		case len(files) == 0:
			// Cancelled.
		default:
			a.importProjects(files[0].Path)
		}
	})
}
