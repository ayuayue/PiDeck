//go:build !js && !android && !ios

package workbench

// Opening files in an editor outside the app: the one the user names, or
// every one found on PATH, which the menu offers by name and by mark.

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit/brands"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// extEditor is an editor the app can start.
type extEditor struct {
	Name    string `json:"name"`
	Command string `json:"command"`
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

// editorMarks are the marks filed under another name than the command.
var editorMarks = map[string]string{
	"code":          "visualstudiocode",
	"code-insiders": "visualstudiocode",
	"zed":           "zedindustries",
	"subl":          "sublimetext",
	"idea":          "intellijidea",
}

// editorScan keeps the candidates that resolve on this machine. LookPath
// reads the disk, so startup discovery runs it off the UI thread.
var editorScan = scanExternalEditors

// detectEditors is the editors this machine has.
func detectEditors() []extEditor { return editorScan() }

// editorChoices is what the menu offers: the user's command first, even when
// it is not one the app knows, so it stays the app's default.
func editorChoices(detected []extEditor, configured string) []extEditor {
	configured = strings.TrimSpace(configured)
	if configured == "" {
		return detected
	}
	for i, e := range detected {
		if sameEditorCommand(e.Command, configured) {
			out := make([]extEditor, 0, len(detected))
			out = append(out, e)
			out = append(out, detected[:i]...)
			out = append(out, detected[i+1:]...)
			return out
		}
	}
	return append([]extEditor{{Name: editorDisplayName(configured), Command: configured}}, detected...)
}

// discoverEditors publishes the startup probe on the UI thread.
func (a *app) discoverEditors() {
	go func() {
		list := detectEditors()
		a.cx.Post(func() { a.externalEditors.Set(list) })
	}()
}

// editors reads the startup result without probing the machine. A configured
// command remains available while discovery is still running.
func (a *app) editors() []extEditor {
	a.settingsTick()
	list := a.cfg.ExternalEditors
	if list == nil && a.externalEditors != nil {
		list = a.externalEditors.Get()
	}
	return editorChoices(list, a.cfg.EditorCommand)
}

// editorCommand is the user's editor, or the first one detected.
func (a *app) editorCommand() string {
	if list := a.editors(); len(list) > 0 {
		return list[0].Command
	}
	return ""
}

// editorMark is the mark of the editor a menu would open by default.
func editorMark(list []extEditor) func() *core.SVG {
	if len(list) == 0 {
		return lucide.Code
	}
	return editorMarkOf(list[0].Command)
}

// editorMarkOf is the editor's own mark in the brands set, and the code
// glyph for one the set does not draw.
func editorMarkOf(command string) func() *core.SVG {
	return func() *core.SVG {
		hint := editorBrandName(command)
		if mark, ok := editorMarks[hint]; ok {
			hint = mark
		}
		if svg := brands.SVG(hint); svg != nil {
			return svg
		}
		return lucide.Code()
	}
}

// editorBrandName is the command without its folder and extension: the name
// the brands set files an editor under.
func editorBrandName(command string) string {
	name := strings.ToLower(filepath.Base(strings.TrimSpace(command)))
	if ext := filepath.Ext(name); ext != "" {
		name = strings.TrimSuffix(name, ext)
	}
	switch name {
	case "sublime_text":
		return "subl"
	case "idea64", "goland64", "webstorm64", "pycharm64":
		return strings.TrimSuffix(name, "64")
	}
	return name
}

// editorOpenItem is the menu row that opens path outside the app: one row
// when there is one editor, and a submenu of each when there are several,
// so the choice is the user's.
func (a *app) editorOpenItem(path, label, testID string) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		list := a.editors()
		if len(list) <= 1 {
			hint := ""
			if len(list) == 1 {
				hint = list[0].Name
			}
			row := a.menuRow(cx, editorMark(list), label, hint, false, func() { a.openPathInEditor(path) })
			row.TestID = testID
			return row
		}
		rows := make([]core.Node, 0, len(list))
		for _, e := range list {
			e := e
			rows = append(rows, a.menuRow(cx, editorMarkOf(e.Command), e.Name, e.Command, false, func() {
				a.openPathWithEditor(e.Command, path)
			}))
		}
		return ui.Submenu{Text: apptext.T(label), Icon: lucide.Code, Back: apptext.T(label),
			TestID: testID, Children: rows}
	})
}

// openInEditorWith opens path with command.
func (a *app) openInEditorWith(command, path string) error {
	if path == "" {
		return fmt.Errorf("没有路径")
	}
	command = strings.TrimSpace(command)
	if command == "" {
		return fmt.Errorf("%s", apptext.T("没有可用编辑器，请在设置的运行环境中添加。"))
	}
	var cmd *exec.Cmd
	if isBatch(command) {
		cmd = batchCommand(command, []string{path})
	} else {
		cmd = exec.Command(command, path)
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

// openInEditor opens a file or folder in the app's default editor.
func (a *app) openInEditor(path string) error {
	return a.openInEditorWith(a.editorCommand(), path)
}

// openPathInEditor opens a path and toasts a failure.
func (a *app) openPathInEditor(path string) {
	if err := a.openInEditor(path); err != nil {
		a.toast(ui.ToastError, "打不开编辑器", err.Error())
	}
}

// openPathWithEditor opens a path with a named editor and toasts a failure.
func (a *app) openPathWithEditor(command, path string) {
	if err := a.openInEditorWith(command, path); err != nil {
		a.toast(ui.ToastError, "打不开编辑器", err.Error())
	}
}
