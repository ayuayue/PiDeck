package main

// Quick open: a workspace file by name, from the keyboard.

import (
	"path/filepath"

	"github.com/oneo-me/nsgo/base"
	"github.com/oneo-me/nsgo/core"
	"github.com/oneo-me/nsgo/icons/lucide"
	"github.com/oneo-me/nsgo/ui"
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
		a.toast(ui.ToastInfo, T("先打开一个工作区"), T("快速打开会在项目里找文件。"))
		return
	}
	a.quickOpen.Set(true)
}

// quickOpenItems lists every file of the root, so the palette's filter can
// pick from them in the app's order.
func (a *app) quickOpenItems() []base.CommandItem {
	_ = a.activeID.Get()
	_ = a.filesRev.Get()
	files := a.workspaceFiles(a.quickOpenRoot())
	group := T("文件")
	icon := lucide.FileSearch()
	out := make([]base.CommandItem, 0, len(files))
	for _, rel := range files {
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
			Placeholder: T("输入文件名…"),
			SearchLabel: T("文件名"),
			Empty:       T("没有匹配的文件"),
			LoadingText: T("正在读取文件…"),
			Loading:     func() bool { return a.fileIndexBusy(a.quickOpenRoot()) },
			OnSelect:    a.quickOpenPick,
			Label:       T("快速打开文件"),
			TestID:      "quick-open-list",
		},
	}
}
