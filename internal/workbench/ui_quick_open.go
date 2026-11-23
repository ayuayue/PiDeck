//go:build !js && !android && !ios

package workbench

// Quick open: a workspace file by name, from the keyboard.

import (
	"os"
	"path/filepath"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// quickOpenLimit bounds the rows one query shows.
const quickOpenLimit = 200

// quickOpenRoot is the folder quick open searches: the active session's
// project, else the drawer's, else the first project.
func (a *app) quickOpenRoot() string {
	if s := a.active(); s != nil && s.WS != "" {
		return s.WS
	}
	if root := a.files.root.Get(); root != "" {
		return root
	}
	if ws := a.workspaces.Get(); len(ws) > 0 {
		return ws[0].Path
	}
	return ""
}

// openQuickOpen shows the file list, or says why it cannot.
func (a *app) openQuickOpen() {
	if a.quickOpenRoot() == "" {
		a.toast(ui.ToastInfo, apptext.T("先打开一个工作区"), apptext.T("快速打开会在项目里找文件。"))
		return
	}
	a.quickOpen.Set(true)
}

// recentFilesFor lists the editor's recent files under a root, newest
// first, as workspace-relative paths.
func (a *app) recentFilesFor(root string) []string {
	if root == "" {
		return nil
	}
	var out []string
	for _, p := range a.cfg.RecentFiles {
		rel, err := filepath.Rel(root, p)
		if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
			continue
		}
		if info, err := os.Stat(p); err != nil || info.IsDir() {
			continue
		}
		out = append(out, filepath.ToSlash(rel))
	}
	return out
}

// quickOpenItems lists every file of the root, with the editor's recent
// files first, so the palette's filter can pick from them in this order.
func (a *app) quickOpenItems() []base.CommandItem {
	_ = a.activeID.Get()
	_ = a.filesRev.Get()
	root := a.quickOpenRoot()
	files := a.workspaceFiles(root)
	group, recentGroup := apptext.T("文件"), apptext.T("最近")
	icon := lucide.FileSearch()
	out := make([]base.CommandItem, 0, len(files))
	seen := make(map[string]bool, len(files))
	for _, rel := range a.recentFilesFor(root) {
		if seen[rel] {
			continue
		}
		seen[rel] = true
		out = append(out, base.CommandItem{ID: rel, Label: rel, Group: recentGroup, Icon: icon})
	}
	for _, rel := range files {
		if seen[rel] {
			continue
		}
		out = append(out, base.CommandItem{ID: rel, Label: rel, Group: group, Icon: icon})
	}
	return out
}

// quickOpenMatches ranks the items for the query.
func quickOpenMatches(items []base.CommandItem, query string) []base.CommandItem {
	labels := make([]string, len(items))
	for i, it := range items {
		labels[i] = it.Label
	}
	byLabel := make(map[string]base.CommandItem, len(items))
	for _, it := range items {
		byLabel[it.ID] = it
	}
	var out []base.CommandItem
	for _, rel := range fileMatches(labels, query, quickOpenLimit) {
		if it, ok := byLabel[rel]; ok {
			out = append(out, it)
		}
	}
	return out
}

// quickOpenPick opens the file chosen.
func (a *app) quickOpenPick(rel string) {
	root := a.quickOpenRoot()
	a.quickOpen.Set(false)
	if root == "" || rel == "" {
		return
	}
	a.openEditorFile(root, filepath.Join(root, filepath.FromSlash(rel)))
}

// quickOpenDialog is the file palette.
func (a *app) quickOpenDialog() core.Node {
	return ui.CommandDialog{
		Open:         a.quickOpen.Get,
		OnOpenChange: func(open bool, _ base.Reason) { a.quickOpen.Set(open) },
		TestID:       "quick-open",
		Command: ui.Command{
			Items:       a.quickOpenItems,
			Filter:      quickOpenMatches,
			Placeholder: apptext.T("输入文件名…"),
			SearchLabel: apptext.T("文件名"),
			Empty:       apptext.T("没有匹配的文件"),
			LoadingText: apptext.T("正在读取文件…"),
			Loading:     func() bool { return a.fileIndexBusy(a.quickOpenRoot()) },
			OnSelect:    a.quickOpenPick,
			Label:       apptext.T("快速打开文件"),
			TestID:      "quick-open-list",
		},
	}
}
