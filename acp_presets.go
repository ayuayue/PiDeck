package main

// Custom ACP presets: the three built-ins, plus any JSON file under the
// data folder's acp directory. A file is {"presets": [...]} or a bare
// array, so a user can add any ACP CLI without rebuilding the app.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/nsgo-dev/nsgo/ui"
)

// acpPresetFile is one file's presets.
type acpPresetFile struct {
	Presets []acpPreset `json:"presets"`
}

// acpDir is where custom presets live.
func (a *app) acpDir() string {
	if a.st == nil {
		return ""
	}
	return filepath.Join(a.st.dir, "acp")
}

// acpPresetList is the built-ins followed by the files' presets.
func (a *app) acpPresetList() []acpPreset {
	out := acpPresets()
	seen := map[string]bool{}
	for _, p := range out {
		seen[p.ID] = true
	}
	dir := a.acpDir()
	if dir == "" {
		return out
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var file acpPresetFile
		if json.Unmarshal(raw, &file) != nil || len(file.Presets) == 0 {
			if json.Unmarshal(raw, &file.Presets) != nil {
				continue
			}
		}
		for _, p := range file.Presets {
			p.ID = strings.TrimSpace(p.ID)
			p.Name = strings.TrimSpace(p.Name)
			p.Command = strings.TrimSpace(p.Command)
			if p.ID == "" || p.Name == "" || p.Command == "" || seen[p.ID] {
				continue
			}
			seen[p.ID] = true
			out = append(out, p)
		}
	}
	return out
}

// acpPresetByID finds a preset, built-in or custom.
func (a *app) acpPresetByID(id string) *acpPreset {
	for _, p := range a.acpPresetList() {
		if p.ID == id {
			cp := p
			return &cp
		}
	}
	return nil
}

// openACPDir shows where custom presets go, with the folder made.
func (a *app) openACPDir() {
	dir := a.acpDir()
	if dir == "" {
		return
	}
	_ = os.MkdirAll(dir, 0o755)
	a.cx.OpenURL(fileURL(dir), nil)
}

// acpCustomFile is the file the preset manager reads and writes.
func (a *app) acpCustomFile() string {
	dir := a.acpDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "presets.json")
}

// acpCustomPresets reads the presets the manager can edit.
func (a *app) acpCustomPresets() []acpPreset {
	path := a.acpCustomFile()
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var file acpPresetFile
	if json.Unmarshal(raw, &file) != nil || len(file.Presets) == 0 {
		if json.Unmarshal(raw, &file.Presets) != nil {
			return nil
		}
	}
	out := make([]acpPreset, 0, len(file.Presets))
	for _, p := range file.Presets {
		p.ID = strings.TrimSpace(p.ID)
		p.Name = strings.TrimSpace(p.Name)
		p.Command = strings.TrimSpace(p.Command)
		if p.ID == "" || p.Name == "" || p.Command == "" {
			continue
		}
		out = append(out, p)
	}
	return out
}

// saveACPPresets writes the editable list.
func (a *app) saveACPPresets(list []acpPreset) error {
	path := a.acpCustomFile()
	if path == "" {
		return fmt.Errorf("找不到数据目录")
	}
	if err := os.MkdirAll(a.acpDir(), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(acpPresetFile{Presets: list}, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(path, data, 0o644)
}

// addACPPreset appends one from the manager's fields.
func (a *app) addACPPreset() {
	id := strings.TrimSpace(a.acpNewID.GetUntracked())
	name := strings.TrimSpace(a.acpNewName.GetUntracked())
	command := strings.TrimSpace(a.acpNewCommand.GetUntracked())
	args := strings.Fields(a.acpNewArgs.GetUntracked())
	switch {
	case id == "" || name == "" || command == "":
		a.acpManageErr.Set("id、名称和命令都要填。")
		return
	case !marketID.MatchString(id):
		a.acpManageErr.Set("id 只能包含字母、数字、点、下划线和短横线。")
		return
	}
	for _, p := range a.acpPresetList() {
		if p.ID == id {
			a.acpManageErr.Set("已经有这个 id 的预设。")
			return
		}
	}
	list := append(a.acpCustomPresets(), acpPreset{ID: id, Name: name, Command: command, Args: args})
	if err := a.saveACPPresets(list); err != nil {
		a.acpManageErr.Set(err.Error())
		return
	}
	a.acpManageErr.Set("")
	a.acpManageRev.Update(func(n int) int { return n + 1 })
	a.acpNewID.Set("")
	a.acpNewName.Set("")
	a.acpNewCommand.Set("")
	a.acpNewArgs.Set("")
	a.toast(ui.ToastSuccess, "已添加 ACP 预设", name)
}

// removeACPPreset deletes one editable preset.
func (a *app) removeACPPreset(id string) {
	var out []acpPreset
	for _, p := range a.acpCustomPresets() {
		if p.ID != id {
			out = append(out, p)
		}
	}
	if err := a.saveACPPresets(out); err != nil {
		a.toast(ui.ToastError, "删除预设失败", err.Error())
		return
	}
	a.acpManageRev.Update(func(n int) int { return n + 1 })
	a.toast(ui.ToastInfo, "已删除预设", id)
}
