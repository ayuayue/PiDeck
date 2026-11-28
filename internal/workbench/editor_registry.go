//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"hash/fnv"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"

	"example.com/pideck/internal/apptext"
)

// sameEditorCommand also recognizes a legacy PATH name after discovery has
// resolved it to an absolute path. Two different installed paths stay distinct.
func sameEditorCommand(a, b string) bool {
	a, b = strings.TrimSpace(a), strings.TrimSpace(b)
	if a == b || runtime.GOOS == "windows" && strings.EqualFold(a, b) {
		return true
	}
	if filepath.Base(a) == a || filepath.Base(b) == b {
		return editorBrandName(a) == editorBrandName(b)
	}
	return false
}

func editorDisplayName(command string) string {
	for _, candidate := range editorCandidates() {
		if sameEditorCommand(candidate.Command, command) {
			return candidate.Name
		}
	}
	return command
}

// scanExternalEditors runs only in a worker. Keep the resolved path so both
// settings and the launcher refer to the installation that was actually found.
func scanExternalEditors() []extEditor {
	var found []extEditor
	for _, candidate := range editorCandidates() {
		if path, err := exec.LookPath(candidate.Command); err == nil {
			if path, err = filepath.Abs(path); err == nil {
				found = append(found, extEditor{candidate.Name, path})
			}
		}
	}
	var installed []extEditor
	switch runtime.GOOS {
	case "windows":
		for _, root := range []string{os.Getenv("LOCALAPPDATA"), os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)")} {
			if root == "" {
				continue
			}
			for _, relative := range []extEditor{
				{"VS Code", "Microsoft VS Code/Code.exe"}, {"VS Code", "Programs/Microsoft VS Code/Code.exe"},
				{"Cursor", "Programs/cursor/Cursor.exe"}, {"Windsurf", "Programs/Windsurf/Windsurf.exe"},
				{"Zed", "Programs/Zed/zed.exe"}, {"Sublime Text", "Sublime Text/sublime_text.exe"},
			} {
				installed = append(installed, extEditor{relative.Name, filepath.Join(root, filepath.FromSlash(relative.Command))})
			}
		}
	case "darwin":
		home, _ := os.UserHomeDir()
		for _, root := range []string{"/Applications", filepath.Join(home, "Applications")} {
			for _, relative := range []extEditor{
				{"VS Code", "Visual Studio Code.app/Contents/Resources/app/bin/code"},
				{"Cursor", "Cursor.app/Contents/Resources/app/bin/cursor"},
				{"Windsurf", "Windsurf.app/Contents/Resources/app/bin/windsurf"},
				{"Zed", "Zed.app/Contents/MacOS/cli"},
				{"Sublime Text", "Sublime Text.app/Contents/SharedSupport/bin/subl"},
			} {
				installed = append(installed, extEditor{relative.Name, filepath.Join(root, filepath.FromSlash(relative.Command))})
			}
		}
	}
	for _, candidate := range installed {
		if info, err := os.Stat(candidate.Command); err == nil && !info.IsDir() {
			// PATH shims and the native program are the same installation for
			// these known apps. Prefer its command-line entry when available.
			if !slices.ContainsFunc(found, func(e extEditor) bool { return e.Name == candidate.Name }) {
				found = append(found, candidate)
			}
		}
	}
	return found
}

func normalizeExternalEditors(c *config) bool {
	if c.ExternalEditors == nil {
		return false
	}
	clean := make([]extEditor, 0, len(c.ExternalEditors))
	for _, editor := range c.ExternalEditors {
		editor.Name, editor.Command = strings.TrimSpace(editor.Name), strings.TrimSpace(editor.Command)
		if editor.Command == "" || slices.ContainsFunc(clean, func(e extEditor) bool { return sameEditorCommand(e.Command, editor.Command) }) {
			continue
		}
		if editor.Name == "" {
			editor.Name = editorDisplayName(editor.Command)
		}
		clean = append(clean, editor)
	}
	changed := !slices.Equal(clean, c.ExternalEditors)
	c.ExternalEditors = clean
	return changed
}

func (a *app) saveExternalEditors(list []extEditor, command string) {
	// Allocate even for an empty list; nil would turn discovery back on.
	a.cfg.ExternalEditors = append([]extEditor{}, list...)
	a.cfg.EditorCommand = command
	if a.st != nil {
		saved := append([]extEditor{}, list...)
		a.st.change(func(c *config) { c.ExternalEditors, c.EditorCommand = saved, command })
		a.saveConfigAsync()
	}
	a.bumpSettings()
}

func editorKey(command string) string {
	if runtime.GOOS == "windows" {
		command = strings.ToLower(command)
	}
	h := fnv.New64a()
	_, _ = h.Write([]byte(command))
	return strconv.FormatUint(h.Sum64(), 16)
}

// addExternalEditor resolves on a worker and publishes both the saved list and
// completion on the UI queue, leaving an invalid draft available for correction.
func (a *app) addExternalEditor(name, command string, complete func(error)) {
	go func() {
		resolved, err := exec.LookPath(strings.TrimSpace(command))
		if err == nil {
			resolved, err = filepath.Abs(resolved)
		}
		a.cx.Post(func() {
			if err != nil {
				complete(fmt.Errorf("%s", apptext.T("找不到程序，请选择可执行文件；不要填写启动参数。")))
				return
			}
			list := slices.Clone(a.editors())
			if slices.ContainsFunc(list, func(e extEditor) bool { return sameEditorCommand(e.Command, resolved) }) {
				complete(fmt.Errorf("%s", apptext.T("该编辑器已在列表中。")))
				return
			}
			name = strings.TrimSpace(name)
			if name == "" {
				name = editorDisplayName(resolved)
				if name == resolved {
					name = filepath.Base(resolved)
				}
			}
			list = append(list, extEditor{name, resolved})
			a.saveExternalEditors(list, a.cfg.EditorCommand)
			complete(nil)
		})
	}()
}

func (a *app) rescanExternalEditors(complete func()) {
	go func() {
		found := detectEditors()
		a.cx.Post(func() {
			list := append([]extEditor{}, a.editors()...)
			for _, editor := range found {
				if !slices.ContainsFunc(list, func(e extEditor) bool { return sameEditorCommand(e.Command, editor.Command) }) {
					list = append(list, editor)
				}
			}
			if a.externalEditors != nil {
				a.externalEditors.Set(found)
			}
			a.saveExternalEditors(list, a.cfg.EditorCommand)
			complete()
		})
	}()
}

func (a *app) removeExternalEditor(command string) {
	list := slices.DeleteFunc(slices.Clone(a.editors()), func(e extEditor) bool { return sameEditorCommand(e.Command, command) })
	selected := a.cfg.EditorCommand
	if sameEditorCommand(selected, command) {
		selected = ""
	}
	a.saveExternalEditors(list, selected)
}
