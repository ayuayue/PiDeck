//go:build !js && !android && !ios

package workbench

// Custom ACP presets: the built-ins, plus any JSON file under the data
// folder's acp directory. A file is {"presets": [...]} or a bare array, so
// a user can add any ACP CLI without rebuilding the app. An entry with a
// built-in's id overrides what that preset launches and keeps the docs and
// install line only the built-in knows.

import (
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/ui"
)

// acpPresetFile is one file's presets.
type acpPresetFile struct {
	Presets []acpPreset `json:"presets"`
}

type acpPresetStatus struct {
	label string
	ready bool
}

type acpManagerSnapshot struct {
	checked bool
	npm     bool
	presets []acpPreset
	status  map[string]acpPresetStatus
}

// acpEnvKey and acpEnvLimit bound what a preset may put in the agent's
// environment: a bad key would be dropped by the shell anyway, and a huge
// value is a mistake, not a setting.
var acpEnvKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

const (
	acpEnvLimit    = 16
	acpEnvValueMax = 2000
)

// sanitizeACPEnv keeps the entries a process can actually use.
func sanitizeACPEnv(env map[string]string) map[string]string {
	out := make(map[string]string, len(env))
	for key, value := range env {
		if len(out) >= acpEnvLimit || !acpEnvKey.MatchString(key) {
			continue
		}
		value = strings.TrimRight(value, "\r\n")
		if value == "" || len(value) > acpEnvValueMax || strings.ContainsFunc(value, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
			continue
		}
		out[key] = value
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// acpNormalizePreset trims a preset read from a file and drops what cannot
// run; the caller skips it when an id, name or command is missing.
func acpNormalizePreset(p acpPreset) acpPreset {
	p.ID = strings.TrimSpace(p.ID)
	p.Name = strings.TrimSpace(p.Name)
	p.Command = strings.TrimSpace(p.Command)
	args := make([]string, 0, len(p.Args))
	for _, arg := range p.Args {
		if strings.TrimSpace(arg) != "" {
			args = append(args, arg)
		}
	}
	p.Args = args
	p.Env = sanitizeACPEnv(p.Env)
	p.Builtin, p.Edited = false, false
	return p
}

// acpEnvText writes a preset's variables on one line, which is what the
// manager's field has room for: KEY=VALUE pairs joined by ';'.
func acpEnvText(env map[string]string) string {
	lines := make([]string, 0, len(env))
	for _, key := range slices.Sorted(maps.Keys(env)) {
		lines = append(lines, key+"="+env[key])
	}
	return strings.Join(lines, "; ")
}

// acpParseEnv reads them back: one KEY=VALUE per line, or several on one
// line separated by ';'. A line without '=' is ignored.
func acpParseEnv(text string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.FieldsFunc(text, func(r rune) bool { return r == '\n' || r == ';' }) {
		line = strings.TrimSpace(line)
		key, value, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(key) == "" {
			continue
		}
		out[strings.TrimSpace(key)] = strings.TrimLeft(value, " ")
	}
	return sanitizeACPEnv(out)
}

// acpBuiltinPreset finds a shipped preset by id.
func acpBuiltinPreset(id string) *acpPreset {
	for _, p := range acpPresets() {
		if p.ID == id {
			cp := p
			return &cp
		}
	}
	return nil
}

func (a *app) refreshACPManager() {
	a.acpManageProbe++
	probe := a.acpManageProbe
	go func() {
		presets := a.acpPresetList()
		status := make(map[string]acpPresetStatus, len(presets))
		for _, p := range presets {
			label, ready := acpPresetState(p)
			status[p.ID] = acpPresetStatus{label, ready}
		}
		_, npmErr := exec.LookPath("npm")
		a.cx.Post(func() {
			if probe != a.acpManageProbe {
				return
			}
			a.acpManager.Set(acpManagerSnapshot{checked: true, npm: npmErr == nil, presets: presets, status: status})
			// Opened without a picked preset: show the first one.
			if a.acpManagePick && a.acpManageOpen.GetUntracked() {
				a.acpManagePick = false
				if len(presets) > 0 {
					a.editACPPreset(presets[0])
				}
			}
		})
	}()
}

// acpDir is where custom presets live.
func (a *app) acpDir() string {
	if a.st == nil {
		return ""
	}
	return filepath.Join(a.st.dir, "acp")
}

// acpPresetList is the built-ins, each replaced in place by a file entry
// with the same id, then the file's own presets.
func (a *app) acpPresetList() []acpPreset {
	out := acpPresets()
	index := make(map[string]int, len(out))
	for i, p := range out {
		index[p.ID] = i
	}
	for _, p := range a.acpFilePresets() {
		if i, ok := index[p.ID]; ok {
			// The first entry for an id wins. A built-in is replaced by
			// the file entry, keeping what only the built-in knows: docs,
			// the install package and whether npx fetches the command.
			if out[i].Builtin && !out[i].Edited {
				p.Homepage, p.Install, p.Npx = out[i].Homepage, out[i].Install, out[i].Npx
				p.Builtin, p.Edited = true, true
				out[i] = p
			}
			continue
		}
		index[p.ID] = len(out)
		out = append(out, p)
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
	go func() {
		err := os.MkdirAll(dir, 0o755)
		a.cx.Post(func() {
			if err != nil {
				a.toast(ui.ToastError, "打开目录失败", err.Error())
				return
			}
			a.cx.OpenURL(fileURL(dir), nil)
		})
	}()
}

// acpCustomFile is the file the preset manager reads and writes.
func (a *app) acpCustomFile() string {
	dir := a.acpDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "presets.json")
}

// acpFilePresets reads every preset the acp directory declares, whatever
// file it is in, in file-name order.
func (a *app) acpFilePresets() []acpPreset {
	dir := a.acpDir()
	if dir == "" {
		return nil
	}
	entries, _ := os.ReadDir(dir)
	var out []acpPreset
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".json") {
			continue
		}
		for _, p := range readACPPresetFile(filepath.Join(dir, e.Name())) {
			p = acpNormalizePreset(p)
			if p.ID == "" || p.Name == "" || p.Command == "" {
				continue
			}
			out = append(out, p)
		}
	}
	return out
}

// readACPPresetFile reads one file: {"presets": [...]} or a bare array.
func readACPPresetFile(path string) []acpPreset {
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
	return file.Presets
}

// acpCustomPresets reads the presets the manager can edit.
func (a *app) acpCustomPresets() []acpPreset {
	path := a.acpCustomFile()
	if path == "" {
		return nil
	}
	var out []acpPreset
	for _, p := range readACPPresetFile(path) {
		p = acpNormalizePreset(p)
		if p.ID == "" || p.Name == "" || p.Command == "" {
			continue
		}
		out = append(out, p)
	}
	return out
}

// saveACPPresets writes the editable list. The file can hold API keys a
// preset passes in its environment, so it is private.
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
	return writeFileAtomic(path, data, 0o600)
}

// upsertACPPreset replaces a preset in the editable list, or appends it.
func upsertACPPreset(list []acpPreset, preset acpPreset) []acpPreset {
	for i := range list {
		if list[i].ID == preset.ID {
			list[i] = preset
			return list
		}
	}
	return append(list, preset)
}

// editACPPreset loads one preset into the manager's fields.
func (a *app) editACPPreset(preset acpPreset) {
	a.acpManagePick = false
	a.acpPresetSel.Set(preset.ID)
	a.acpEditID.Set(preset.ID)
	a.acpEditName.Set(preset.Name)
	a.acpEditCommand.Set(preset.Command)
	a.acpEditArgs.Set(strings.Join(preset.Args, " "))
	a.acpEditEnv.Set(acpEnvText(preset.Env))
	a.acpEditBypass.Set(preset.BypassPermissions)
	a.acpManageErr.Set("")
}

// newACPPreset empties the fields for a preset the user writes from scratch.
func (a *app) newACPPreset() {
	a.acpManagePick = false
	a.acpPresetSel.Set("")
	a.acpEditID.Set("")
	a.acpEditName.Set("")
	a.acpEditCommand.Set("")
	a.acpEditArgs.Set("")
	a.acpEditEnv.Set("")
	a.acpEditBypass.Set(false)
	a.acpManageErr.Set("")
	a.acpPresetTab.Set("launch")
}

// saveACPPresetEdit writes the fields as one preset: a new id appends, an
// existing one — a built-in included — replaces it.
func (a *app) saveACPPresetEdit() {
	if a.acpManageBusy.GetUntracked() {
		return
	}
	preset := acpPreset{
		ID:                strings.TrimSpace(a.acpEditID.GetUntracked()),
		Name:              strings.TrimSpace(a.acpEditName.GetUntracked()),
		Command:           strings.TrimSpace(a.acpEditCommand.GetUntracked()),
		Args:              strings.Fields(a.acpEditArgs.GetUntracked()),
		Env:               acpParseEnv(a.acpEditEnv.GetUntracked()),
		BypassPermissions: a.acpEditBypass.GetUntracked(),
	}
	switch {
	case preset.ID == "" || preset.Name == "" || preset.Command == "":
		a.acpManageErr.Set(apptext.T("id、名称和命令都要填。"))
		return
	case !marketID.MatchString(preset.ID):
		a.acpManageErr.Set(apptext.T("id 只能包含字母、数字、点、下划线和短横线。"))
		return
	}
	a.acpManageBusy.Set(true)
	a.acpManageErr.Set("")
	go func() {
		list := upsertACPPreset(a.acpCustomPresets(), preset)
		err := a.saveACPPresets(list)
		a.cx.Post(func() {
			a.acpManageBusy.Set(false)
			if err != nil {
				a.acpManageErr.Set(err.Error())
				return
			}
			a.acpPresetSel.Set(preset.ID)
			// An edited command or environment makes the waiting process stale.
			a.retireWarmACP("")
			a.refreshACPManager()
			a.toast(ui.ToastSuccess, "已保存 ACP 预设", preset.Name)
		})
	}()
}

// removeACPPreset drops the user's entry: a custom preset goes away, a
// built-in returns to what it ships with.
func (a *app) removeACPPreset(id string) {
	if a.acpManageBusy.GetUntracked() {
		return
	}
	builtin := acpBuiltinPreset(id) != nil
	a.acpManageBusy.Set(true)
	go func() {
		var out []acpPreset
		for _, p := range a.acpCustomPresets() {
			if p.ID != id {
				out = append(out, p)
			}
		}
		err := a.saveACPPresets(out)
		a.cx.Post(func() {
			a.acpManageBusy.Set(false)
			if err != nil {
				a.toast(ui.ToastError, "删除预设失败", err.Error())
				return
			}
			if builtin {
				if p := acpBuiltinPreset(id); p != nil {
					a.editACPPreset(*p)
				}
				a.toast(ui.ToastInfo, "已恢复默认", id)
			} else {
				a.newACPPreset()
				a.toast(ui.ToastInfo, "已删除预设", id)
			}
			a.retireWarmACP("")
			a.refreshACPManager()
		})
	}()
}

// acpPresetInstall is what the user runs to get a preset's CLI here.
func acpPresetInstall(p acpPreset) string {
	if p.Npx || p.Install == "" {
		return ""
	}
	return "npm install -g " + p.Install
}

// acpPresetReady says whether a preset can start here: npx presets need
// Node.js' npx, the others their own command on the path.
func acpPresetReady(p acpPreset) (string, bool) {
	want := p.Command
	if p.Npx {
		want = "npx"
	}
	path, err := exec.LookPath(want)
	if err != nil {
		return "", false
	}
	return path, true
}

// acpPresetState is a preset's readiness as one line.
func acpPresetState(p acpPreset) (string, bool) {
	path, ok := acpPresetReady(p)
	switch {
	case ok && p.Npx:
		return apptext.T("npx 已就绪 · 首次运行会下载它"), true
	case ok:
		return apptext.T("已安装 · %s", shorten(filepath.Base(path), 40)), true
	case p.Npx:
		return apptext.T("需要 Node.js：找不到 npx"), false
	case p.Install != "":
		return apptext.T("未安装 · %s", acpPresetInstall(p)), false
	}
	return apptext.T("未安装 · 按官网说明安装"), false
}
