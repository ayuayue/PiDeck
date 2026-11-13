package main

// Opening files in an editor outside the app: the one the user names, or
// the first of the common ones found on PATH.

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/oneo-me/nsgo/ui"
)

// extEditor is an editor found on PATH.
type extEditor struct {
	Name    string
	Command string
}

// editorCandidates are the editors the app looks for, in order.
func editorCandidates() []extEditor {
	return []extEditor{
		{"VS Code", "code"},
		{"Cursor", "cursor"},
		{"Windsurf", "windsurf"},
		{"Zed", "zed"},
		{"Sublime Text", "subl"},
		{"IntelliJ IDEA", "idea"},
		{"GoLand", "goland"},
		{"WebStorm", "webstorm"},
		{"PyCharm", "pycharm"},
	}
}

// detectEditors keeps the candidates that resolve on this machine.
func detectEditors() []extEditor {
	var out []extEditor
	for _, e := range editorCandidates() {
		if _, err := exec.LookPath(e.Command); err == nil {
			out = append(out, e)
		}
	}
	return out
}

// editorCommand is the user's editor, or the first one detected.
func (a *app) editorCommand() string {
	if cmd := strings.TrimSpace(a.cfg.EditorCommand); cmd != "" {
		return cmd
	}
	if list := detectEditors(); len(list) > 0 {
		return list[0].Command
	}
	return ""
}

// openInEditor opens a file or folder in the external editor.
func (a *app) openInEditor(path string) error {
	if path == "" {
		return fmt.Errorf("没有路径")
	}
	cmdName := a.editorCommand()
	if cmdName == "" {
		return fmt.Errorf("没有找到编辑器；在 设置 → 环境 里填一个命令")
	}
	var cmd *exec.Cmd
	if isBatch(cmdName) {
		cmd = batchCommand(cmdName, []string{path})
	} else {
		cmd = exec.Command(cmdName, path)
	}
	if info, err := filepath.Abs(path); err == nil {
		cmd.Dir = filepath.Dir(info)
	}
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

// openPathInEditor opens a path and toasts a failure.
func (a *app) openPathInEditor(path string) {
	if err := a.openInEditor(path); err != nil {
		a.toast(ui.ToastError, "打不开编辑器", err.Error())
	}
}
