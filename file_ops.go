package main

// File operations from the drawer's tree: a new file or folder, and a
// rename. The name dialog is shared; the checks run before the action.

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/oneo-me/nsgo/base"
	"github.com/oneo-me/nsgo/core"
	"github.com/oneo-me/nsgo/ui"
)

// askFileName opens the dialog with an action to run on the chosen name.
func (a *app) askFileName(title, initial string, action func(string)) {
	a.fileOpTitle.Set(title)
	a.fileOpText.Set(initial)
	a.fileOpAction = action
	a.fileOpOpen.Set(true)
}

// confirmFileName checks the name and runs the pending action.
func (a *app) confirmFileName() {
	name := strings.TrimSpace(a.fileOpText.GetUntracked())
	action := a.fileOpAction
	if action == nil {
		a.fileOpOpen.Set(false)
		return
	}
	if problem := fileNameProblem(name); problem != "" {
		a.toast(ui.ToastWarning, problem, name)
		return
	}
	a.fileOpOpen.Set(false)
	action(name)
}

// fileNameProblem says why a name cannot be used, or "" when it can.
func fileNameProblem(name string) string {
	switch {
	case name == "" || name == "." || name == "..":
		return "名字不能为空"
	case strings.ContainsAny(name, `/\`) || filepath.Base(name) != name:
		return "名字里不能有路径分隔符"
	}
	return ""
}

// fileOpDialog names a new file, folder or renamed entry.
func (a *app) fileOpDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return ui.Dialog{
			Open:         a.fileOpOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.fileOpOpen.Set(open) },
			Title:        T(a.fileOpTitle.Get()),
			TestID:       "file-op",
			Children: []core.Node{core.Input{
				Value: a.fileOpText.Get, OnChange: a.fileOpText.Set, Placeholder: T("名称"), Label: T("名称"), AutoFocus: true,
				TestID: "file-op-name",
				OnSubmit: func(string) {
					a.confirmFileName()
				},
				StyleFunc: func() core.Style {
					return core.Style{Height: core.Pt(34), Padding: core.Symmetric(0, 10), CornerRadius: 7, Background: colors.Field(),
						BorderWidth: 1, BorderColor: colors.FieldBorder(), Color: colors.Text(), FontSize: 13}
				},
			}},
			Footer: []core.Node{
				ui.Button{Text: T("取消"), Variant: ui.ButtonGhost, TestID: "file-op-cancel",
					OnPress: func() { a.fileOpOpen.Set(false) }},
				ui.Button{Text: T("确定"), Variant: ui.ButtonPrimary, TestID: "file-op-confirm",
					OnPress: func() { a.confirmFileName() }},
			},
		}
	})
}

// newFileIn makes an empty file in dir and opens it in the editor.
func (a *app) newFileIn(dir string) {
	a.askFileName("新建文件", "", func(name string) {
		path := filepath.Join(dir, name)
		if _, err := os.Stat(path); err == nil {
			a.toast(ui.ToastWarning, "已经有一个同名文件", name)
			return
		}
		if err := os.WriteFile(path, nil, 0o644); err != nil {
			a.toast(ui.ToastError, "新建文件失败", err.Error())
			return
		}
		a.files.reload()
		a.openEditorFile(a.files.root.GetUntracked(), path)
	})
}

// newFolderIn makes a folder in dir.
func (a *app) newFolderIn(dir string) {
	a.askFileName("新建文件夹", "", func(name string) {
		path := filepath.Join(dir, name)
		if _, err := os.Stat(path); err == nil {
			a.toast(ui.ToastWarning, "已经有一个同名文件或文件夹", name)
			return
		}
		if err := os.Mkdir(path, 0o755); err != nil {
			a.toast(ui.ToastError, "新建文件夹失败", err.Error())
			return
		}
		a.files.reload()
	})
}

// renameFileNode renames a file or folder and follows it in the editor.
func (a *app) renameFileNode(path string) {
	a.askFileName("重命名", filepath.Base(path), func(name string) {
		next := filepath.Join(filepath.Dir(path), name)
		if next == path {
			return
		}
		if _, err := os.Stat(next); err == nil {
			a.toast(ui.ToastWarning, "已经有一个同名文件或文件夹", name)
			return
		}
		if err := os.Rename(path, next); err != nil {
			a.toast(ui.ToastError, "重命名失败", err.Error())
			return
		}
		a.editor.renamePath(path, next)
		a.files.reload()
	})
}
