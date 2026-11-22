//go:build !js && !android && !ios

package workbench

// pi's skills and extensions, for the resources page: what is installed,
// what it says it does, and whether it is on. Skills are folders with a
// SKILL.md; extensions are builtins, npm packages or local .ts files.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/nsgo-dev/nsgo/ui"
	yaml "go.yaml.in/yaml/v3"
)

// skillInfo is one skill folder.
type skillInfo struct {
	Name        string
	Description string
	Dir         string
	File        string
	Error       string
}

// extensionInfo is one extension source or local file.
type extensionInfo struct {
	Source     string // as settings.json names it, without a leading +
	Bare       string
	Path       string
	Builtin    bool
	Local      bool
	Enabled    bool
	Toggleable bool
}

// resourceReport is what the resources page shows.
type resourceReport struct {
	Skills     []skillInfo
	Extensions []extensionInfo
	Err        string
}

// skillsDirs are the folders pi reads skills from, in order.
func skillsDirs() []string {
	dir := piConfigDir()
	if dir == "" {
		return nil
	}
	return []string{filepath.Join(dir, "skills"), filepath.Join(dir, "pideck-skills")}
}

// extensionsDir is where pi's local extension files live.
func extensionsDir() string {
	dir := piConfigDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "extensions")
}

// readSkills lists the skill folders, with their frontmatter.
func readSkills() []skillInfo {
	seen := map[string]bool{}
	var out []skillInfo
	for _, root := range skillsDirs() {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, e := range entries {
			dir := filepath.Join(root, e.Name())
			info, err := os.Stat(dir)
			if err != nil || !info.IsDir() {
				continue
			}
			if seen[dir] {
				continue
			}
			seen[dir] = true
			skill := skillInfo{Name: e.Name(), Dir: dir}
			for _, name := range []string{"SKILL.md", "skill.md", "README.md"} {
				path := filepath.Join(dir, name)
				if _, err := os.Stat(path); err == nil {
					skill.File = path
					break
				}
			}
			if skill.File == "" {
				skill.Error = "没有 SKILL.md"
				out = append(out, skill)
				continue
			}
			raw, err := os.ReadFile(skill.File)
			if err != nil {
				skill.Error = err.Error()
				out = append(out, skill)
				continue
			}
			name, desc := parseSkillFrontmatter(string(raw))
			if name != "" {
				skill.Name = name
			}
			skill.Description = desc
			out = append(out, skill)
		}
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out
}

// parseSkillFrontmatter reads name and description from a SKILL.md.
func parseSkillFrontmatter(text string) (name, description string) {
	text = strings.TrimPrefix(text, "\ufeff")
	if !strings.HasPrefix(text, "---") {
		return "", firstParagraph(text)
	}
	rest := text[3:]
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return "", firstParagraph(text)
	}
	var f struct {
		Name        string `yaml:"name"`
		Description string `yaml:"description"`
	}
	if yaml.Unmarshal([]byte(rest[:end]), &f) != nil {
		return "", ""
	}
	return strings.TrimSpace(f.Name), strings.TrimSpace(f.Description)
}

// firstParagraph is the first non-heading, non-blank line of a document.
func firstParagraph(text string) string {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "---") {
			continue
		}
		return line
	}
	return ""
}

// readExtensions reads pi's settings and the local extension files.
func readExtensions() ([]extensionInfo, error) {
	dir := piConfigDir()
	if dir == "" {
		return nil, fmt.Errorf("找不到 pi 的配置目录")
	}
	path := filepath.Join(dir, "settings.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var root struct {
		Extensions []string `json:"extensions"`
		Disabled   []string `json:"disabledExtensions"`
		Packages   []string `json:"packages"`
	}
	if err := json.Unmarshal(raw, &root); err != nil {
		return nil, fmt.Errorf("settings.json 不是有效的 JSON：%w", err)
	}
	disabled := map[string]bool{}
	for _, d := range root.Disabled {
		disabled[strings.TrimPrefix(d, "+")] = true
	}
	seen := map[string]bool{}
	var out []extensionInfo
	add := func(source string, enabled bool, builtin bool) {
		bare := strings.TrimPrefix(source, "+")
		if bare == "" || seen[bare] {
			return
		}
		seen[bare] = true
		out = append(out, extensionInfo{Source: bare, Bare: bare, Builtin: builtin,
			Enabled: enabled && !disabled[bare], Toggleable: true})
	}
	// Installed packages are listed under packages, not extensions. pi
	// loads a package as a whole; its switch lives in pi's own config UI.
	for _, source := range root.Packages {
		bare := strings.TrimPrefix(source, "+")
		if bare == "" || seen[bare] {
			continue
		}
		seen[bare] = true
		out = append(out, extensionInfo{Source: bare, Bare: bare, Enabled: !disabled[bare]})
	}
	for _, source := range root.Extensions {
		enabled := strings.HasPrefix(source, "+")
		add(source, enabled, strings.HasPrefix(strings.TrimPrefix(source, "+"), "builtin:"))
	}
	for _, source := range root.Disabled {
		add(source, false, strings.HasPrefix(strings.TrimPrefix(source, "+"), "builtin:"))
	}
	// Local .ts files are discovered rather than listed: show them, but
	// leave their switch out.
	if ed := extensionsDir(); ed != "" {
		entries, _ := os.ReadDir(ed)
		for _, e := range entries {
			name := e.Name()
			if e.IsDir() || !strings.HasSuffix(strings.ToLower(name), ".ts") || strings.HasSuffix(strings.ToLower(name), ".d.ts") {
				continue
			}
			out = append(out, extensionInfo{Source: name, Bare: name, Path: filepath.Join(ed, name), Local: true, Enabled: true})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Builtin != out[j].Builtin {
			return out[i].Builtin
		}
		return strings.ToLower(out[i].Source) < strings.ToLower(out[j].Source)
	})
	return out, nil
}

// setExtensionEnabled turns one extension on or off in pi's settings,
// keeping every other field as it was.
func setExtensionEnabled(source string, enabled bool) error {
	bare := strings.TrimPrefix(strings.TrimSpace(source), "+")
	if bare == "" {
		return fmt.Errorf("扩展名为空")
	}
	dir := piConfigDir()
	if dir == "" {
		return fmt.Errorf("找不到 pi 的配置目录")
	}
	path := filepath.Join(dir, "settings.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil {
		return fmt.Errorf("settings.json 不是有效的 JSON：%w", err)
	}
	extensions := stringList(root["extensions"])
	disabled := stringList(root["disabledExtensions"])
	if enabled {
		disabled = removeString(disabled, bare)
		for i, e := range extensions {
			if strings.TrimPrefix(e, "+") == bare {
				extensions[i] = "+" + bare
			}
		}
	} else {
		disabled = appendUnique(disabled, bare)
		for i, e := range extensions {
			if strings.TrimPrefix(e, "+") == bare {
				extensions[i] = bare
			}
		}
	}
	root["extensions"] = extensions
	root["disabledExtensions"] = disabled
	data, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(path, append(data, '\n'), 0o600)
}

// stringList reads a JSON array of strings.
func stringList(v any) []string {
	list, _ := v.([]any)
	out := make([]string, 0, len(list))
	for _, item := range list {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// removeString returns list without value.
func removeString(list []string, value string) []string {
	out := list[:0]
	for _, s := range list {
		if s != value {
			out = append(out, s)
		}
	}
	return out
}

// appendUnique adds value unless it is already there.
func appendUnique(list []string, value string) []string {
	for _, s := range list {
		if s == value {
			return list
		}
	}
	return append(list, value)
}

// loadResources reads skills and extensions in the background.
func (a *app) loadResources(force bool) {
	if a.resourcesLoading.GetUntracked() || (a.resourcesLoaded && !force) {
		return
	}
	a.resourcesLoading.Set(true)
	go func() {
		report := resourceReport{Skills: readSkills()}
		exts, err := readExtensions()
		if err != nil {
			report.Err = err.Error()
		}
		report.Extensions = exts
		a.cx.Post(func() {
			a.resources.Set(report)
			a.resourcesLoading.Set(false)
			a.resourcesLoaded = true
		})
	}()
}

// toggleExtension flips one extension and reloads the list.
func (a *app) toggleExtension(source string, enabled bool) {
	if err := setExtensionEnabled(source, enabled); err != nil {
		a.toast(ui.ToastError, "扩展设置失败", err.Error())
		return
	}
	a.resourcesLoaded = false
	a.loadResources(true)
}

// openSkill shows a skill's SKILL.md in the editor.
func (a *app) openSkill(skill skillInfo) {
	if skill.File == "" {
		a.toast(ui.ToastInfo, "这个技能没有 SKILL.md", skill.Dir)
		return
	}
	a.closePane(paneSettings)
	a.openEditorFile(skill.Dir, skill.File)
}

// openResourcesDir opens one of pi's resource folders.
func (a *app) openResourcesDir(path string) {
	if path == "" {
		return
	}
	_ = os.MkdirAll(path, 0o755)
	a.cx.OpenURL(fileURL(path), nil)
}
