package main

// File operations from the drawer's tree: a new file or folder, and a
// rename. The name dialog is shared; the checks run before the action.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

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

// ignorePath adds a file to the project's .gitignore, making one when the
// project has none.
func (a *app) ignorePath(path string) {
	root := a.files.root.GetUntracked()
	if root == "" {
		root = a.quickOpenRoot()
	}
	if root == "" {
		return
	}
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		a.toast(ui.ToastWarning, "不在项目里", "只能忽略项目里的文件。")
		return
	}
	line := filepath.ToSlash(rel)
	if err := appendGitignore(root, line); err != nil {
		a.toast(ui.ToastError, "写不了 .gitignore", err.Error())
		return
	}
	a.toast(ui.ToastSuccess, "已加入 .gitignore", line)
	a.files.reload()
	if a.gitPath() != "" {
		a.git.refreshAll()
	}
}

// appendGitignore adds a line to a project's .gitignore, once.
func appendGitignore(root, line string) error {
	path := filepath.Join(root, ".gitignore")
	raw, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, l := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(l) == line {
			return nil
		}
	}
	out := string(raw)
	if out != "" && !strings.HasSuffix(out, "\n") {
		out += "\n"
	}
	out += line + "\n"
	mode := os.FileMode(0o644)
	if info, statErr := os.Stat(path); statErr == nil {
		mode = info.Mode()
	}
	return os.WriteFile(path, []byte(out), mode)
}

// trashFile moves a file or folder into the data folder's trash, after
// asking. It is the one destructive file action, so it never runs on a
// press alone.
func (a *app) trashFile(path string) {
	if a.st == nil || strings.TrimSpace(path) == "" {
		return
	}
	name := filepath.Base(path)
	a.askConfirm("移到回收站", "「"+name+"」会移到数据目录的 trash/files 里，需要时可以手动找回。", "移到回收站", func() {
		dest, err := a.moveToTrash(path)
		if err != nil {
			a.toast(ui.ToastError, "移到回收站失败", err.Error())
			return
		}
		a.invalidateFileIndex()
		a.files.reload()
		a.toastAction(ui.ToastInfo, "已移到回收站", dest, "打开", func() {
			a.cx.OpenURL(fileURL(filepath.Dir(dest)), nil)
		})
	})
}

// moveToTrash moves a path under the data folder's trash and returns
// where it went.
func (a *app) moveToTrash(path string) (string, error) {
	if a.st == nil {
		return "", fmt.Errorf("找不到数据目录")
	}
	dir := filepath.Join(a.st.dir, "trash", "files")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	dest := filepath.Join(dir, time.Now().Format("20060102-150405")+"-"+filepath.Base(path))
	if err := movePath(path, dest); err != nil {
		return "", err
	}
	return dest, nil
}

// movePath renames, and copies across volumes when a rename cannot.
func movePath(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	if info.IsDir() {
		if err := copyTree(src, dst); err != nil {
			return err
		}
		return os.RemoveAll(src)
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.WriteFile(dst, data, info.Mode()); err != nil {
		return err
	}
	return os.Remove(src)
}

// copyTree copies a folder, files and modes.
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, info.Mode())
	})
}

// invalidateFileIndex makes the next @ completion rescan the workspace.
func (a *app) invalidateFileIndex() {
	a.fileIdx.mu.Lock()
	a.fileIdx.at = time.Time{}
	a.fileIdx.mu.Unlock()
}
