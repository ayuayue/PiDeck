package main

// Custom ACP presets: the three built-ins, plus any JSON file under the
// data folder's acp directory. A file is {"presets": [...]} or a bare
// array, so a user can add any ACP CLI without rebuilding the app.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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
