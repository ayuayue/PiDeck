//go:build !js && !android && !ios

package workbench

// Looks and add-ons. A theme is a set of palette roles and design tokens
// over the app's own; a plugin is a folder of JSON that adds commands and
// themes. Neither runs code, so a broken add-on can only be dull, not
// dangerous, and both are read again without restarting.
//
// A plugin's manifest is its contract:
//
//	{
//	  "id": "team", "name": "团队提示词", "version": "1.0.0",
//	  "contributes": {
//	    "commands": [{"id": "review", "title": "梳理改动", "icon": "git",
//	      "action": {"type": "prompt", "prompt": "看看未提交的改动。"}}],
//	    "themes": ["themes/team-blue.json"]
//	  }
//	}
//
// Top-level "prompts" and "themes" are the older shape and still load.

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"example.com/pideck-lite/internal/viewkit"
	yaml "go.yaml.in/yaml/v3"
)

// loadPlugins reads every plugin under the plugins folder: a folder with
// plugin.json, or a single JSON file. Bad manifests are listed with their
// error rather than dropped, so the settings page can say what is wrong.
func (a *app) loadPlugins() []plugin {
	dir := a.pluginsDir()
	if dir == "" {
		return nil
	}
	disabled := map[string]bool{}
	for _, id := range a.cfg.DisabledPlugins {
		disabled[id] = true
	}
	var out []plugin
	seen := map[string]int{}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		path, folder := "", ""
		if e.IsDir() {
			folder = filepath.Join(dir, e.Name())
			path = filepath.Join(folder, "plugin.json")
		} else if isJSONFile(e.Name()) {
			path = filepath.Join(dir, e.Name())
		} else {
			continue
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			out = append(out, plugin{Name: e.Name(), Path: path, Error: err.Error()})
			continue
		}
		var p plugin
		if err := yaml.Unmarshal(raw, &p); err != nil {
			out = append(out, plugin{Name: e.Name(), Path: path, Error: err.Error()})
			continue
		}
		p.Path = path
		p.Dir = firstNonEmpty(folder, dir)
		if p.Name == "" {
			p.Name = fileBase(e.Name())
		}
		if p.ID == "" {
			p.ID = p.Name
		}
		if n, dup := seen[p.ID]; dup {
			seen[p.ID] = n + 1
			p.ID = fmt.Sprintf("%s-%d", p.ID, n+1)
		} else {
			seen[p.ID] = 1
		}
		p.Disabled = disabled[p.ID]
		normalizePlugin(&p)
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// normalizePlugin folds the older prompts and inline themes into the
// contributes shape and checks each command and theme path.
func normalizePlugin(p *plugin) {
	if !normalizePluginIdentity(p) {
		return
	}
	declared := normalizePluginSettings(p)
	normalizePluginHooks(p)
	normalizePluginAgents(p)
	for i, pr := range p.Prompts {
		if strings.TrimSpace(pr.Title) == "" || strings.TrimSpace(pr.Prompt) == "" {
			continue
		}
		p.Commands = append(p.Commands, pluginCommand{
			ID:          fmt.Sprintf("prompt-%d", i),
			Title:       pr.Title,
			Description: viewkit.FirstLine(pr.Prompt, 70),
			Group:       pr.Group,
			Icon:        "message",
			Action:      pluginAction{Type: "prompt", Prompt: pr.Prompt},
		})
	}
	for i, f := range p.Themes {
		spec := themeSpec{
			ID:         fmt.Sprintf("plugin:%s:%d", p.ID, i),
			Name:       firstNonEmpty(f.Name, fmt.Sprintf("%s %d", p.Name, i+1)),
			Author:     f.Author,
			Appearance: normalizeAppearance(f.Appearance),
			Light:      f.Light,
			Dark:       f.Dark,
			Tokens:     f.Tokens,
		}
		if f.Radius != nil {
			spec.Radius = *f.Radius
		}
		spec.Sans, spec.Mono = f.Sans, f.Mono
		p.ThemeSpecs = append(p.ThemeSpecs, spec)
	}
	ids := map[string]bool{}
	refs := map[string]bool{}
	for _, c := range p.Contributes.Commands {
		c.ID = strings.TrimSpace(c.ID)
		c.Title = strings.TrimSpace(c.Title)
		if c.ID == "" || c.Title == "" {
			p.Warnings = append(p.Warnings, "跳过一条没有 id 或标题的命令")
			continue
		}
		if ids[c.ID] {
			p.Warnings = append(p.Warnings, "跳过重复的命令 id："+c.ID)
			continue
		}
		if err := validateAction(c.Action); err != nil {
			p.Warnings = append(p.Warnings, fmt.Sprintf("命令 %s：%v", c.ID, err))
			continue
		}
		for _, text := range []string{c.Action.Prompt, c.Action.Command, c.Action.URL, c.Action.Theme} {
			for _, m := range pluginSettingRef.FindAllStringSubmatch(text, -1) {
				if declared[m[1]] || refs[c.ID+"/"+m[1]] {
					continue
				}
				refs[c.ID+"/"+m[1]] = true
				p.Warnings = append(p.Warnings, fmt.Sprintf("命令 %s 引用了未声明的设置 %s", c.ID, m[1]))
			}
		}
		ids[c.ID] = true
		p.Commands = append(p.Commands, c)
	}
	for _, rel := range p.Contributes.Themes {
		path, ok := resolveInside(p.Dir, rel)
		if !ok {
			p.Warnings = append(p.Warnings, "跳过插件目录之外的主题："+rel)
			continue
		}
		spec, err := parseThemeFile(path, fileBase(path))
		if err != nil {
			p.Warnings = append(p.Warnings, fmt.Sprintf("主题 %s 读取失败：%v", rel, err))
			continue
		}
		spec.ID = "plugin:" + p.ID + ":" + firstNonEmpty(spec.ID, fileBase(path))
		if spec.Name == "" {
			spec.Name = fileBase(path)
		}
		p.ThemeSpecs = append(p.ThemeSpecs, spec)
	}
}
