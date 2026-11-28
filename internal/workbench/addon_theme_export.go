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
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// deleteTheme moves a user theme file to the trash and reloads the looks.
func (a *app) deleteTheme(s themeSpec) {
	if s.Builtin || s.Source == "" {
		return
	}
	a.askConfirm("删除主题", "主题文件「"+filepath.Base(s.Source)+"」会移到数据目录的 trash/files。", "删除", func() {
		if a.theme.GetUntracked() == s.ID {
			a.setTheme("system")
		}
		if _, err := a.moveToTrash(s.Source); err != nil {
			a.toast(ui.ToastError, "删除主题失败", err.Error())
			return
		}
		a.reloadAddons()
		a.toast(ui.ToastInfo, "已删除主题", s.Name)
	})
}

// exportTheme writes the current look as a theme file the app reads back.
func (a *app) exportTheme() {
	dir := a.themesDir()
	if dir == "" {
		a.toast(ui.ToastError, "找不到主题目录", "")
		return
	}
	base := viewkit.Theme()
	spec := a.themeSpec(a.theme.GetUntracked())
	if spec != nil {
		applyRoles(&base.Light, spec.Light)
		applyRoles(&base.Dark, spec.Dark)
		for k, c := range spec.LightColors {
			base.Light.SetColor(k, c)
		}
		for k, c := range spec.DarkColors {
			base.Dark.SetColor(k, c)
		}
		if len(spec.Tokens) > 0 {
			if base.Tokens == nil {
				base.Tokens = map[string]string{}
			}
			for k, v := range spec.Tokens {
				base.Tokens[k] = v
			}
		}
		if spec.Radius > 0 {
			base.Radius = core.Points(spec.Radius)
		}
		if spec.Sans != "" {
			base.Sans = spec.Sans
		}
		if spec.Mono != "" {
			base.Mono = spec.Mono
		}
	}
	name, appearance := "我的主题", ""
	if spec != nil {
		name = spec.Name + " 副本"
		appearance = spec.Appearance
	}
	id := "exported-" + time.Now().Format("20060102-150405")
	f := themeFile{ID: id, Name: name, Author: "PiDeck", Appearance: appearance,
		Light: paletteRoleMap(base.Light), Dark: paletteRoleMap(base.Dark), Tokens: base.Tokens,
		Sans: base.Sans, Mono: base.Mono}
	if base.Radius > 0 {
		radius := float32(base.Radius)
		f.Radius = &radius
	}
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		a.toast(ui.ToastError, "导出主题失败", err.Error())
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		a.toast(ui.ToastError, "导出主题失败", err.Error())
		return
	}
	path := filepath.Join(dir, id+".json")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		a.toast(ui.ToastError, "导出主题失败", err.Error())
		return
	}
	a.reloadAddons()
	a.toastAction(ui.ToastSuccess, "已导出主题", path, "打开", func() { a.openEditorFile(dir, path) })
}

// themeSpec finds a look by id.
func (a *app) themeSpec(id string) *themeSpec {
	for _, s := range a.themes.GetUntracked() {
		if s.ID == id {
			cp := s
			return &cp
		}
	}
	return nil
}

// themeSpecByName finds a look by display name, for plugin actions that
// name a theme rather than an id.
func (a *app) themeSpecByName(name string) *themeSpec {
	for _, s := range a.themes.GetUntracked() {
		if s.ID == name || s.Name == name {
			cp := s
			return &cp
		}
	}
	return nil
}

// applyRoles sets the palette roles a theme gives.
func applyRoles(p *core.Palette, roles map[string]string) {
	for name, value := range roles {
		c, err := core.ParseColor(value)
		if err != nil {
			continue
		}
		p.SetColor(name, c)
	}
}
