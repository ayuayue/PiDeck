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
	"path/filepath"
	"strings"

	"example.com/pideck/internal/apptext"
)

// isThemeFile reports whether a name is one the theme loader reads.
func isThemeFile(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".json", ".yaml", ".yml":
		return true
	}
	return false
}

// isJSONFile reports whether a name is a single-file plugin manifest.
func isJSONFile(name string) bool {
	return strings.EqualFold(filepath.Ext(name), ".json")
}

// fileBase is a file's name without its extension.
func fileBase(name string) string {
	return strings.TrimSuffix(filepath.Base(name), filepath.Ext(name))
}

// normalizeAppearance keeps the appearance values the app understands.
func normalizeAppearance(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "light":
		return "light"
	case "dark":
		return "dark"
	case "both":
		return "both"
	}
	return ""
}

// pluginSummary is one line about what a plugin adds.
func pluginSummary(p plugin) string {
	parts := []string{}
	if n := len(p.Commands); n > 0 {
		parts = append(parts, apptext.T("%d 个命令", n))
	}
	if n := len(p.ThemeSpecs); n > 0 {
		parts = append(parts, apptext.T("%d 个主题", n))
	}
	if n := len(p.Contributes.Keybindings); n > 0 {
		parts = append(parts, apptext.T("%d 个键位", n))
	}
	if n := len(p.Contributes.Settings); n > 0 {
		parts = append(parts, apptext.T("%d 个设置", n))
	}
	if n := len(p.Contributes.Hooks); n > 0 {
		parts = append(parts, apptext.T("%d 个事件", n))
	}
	if n := len(p.Contributes.Agents); n > 0 {
		parts = append(parts, apptext.T("%d 个智能体", n))
	}
	if len(parts) == 0 {
		return apptext.T("插件没有可用的贡献项")
	}
	return strings.Join(parts, " · ")
}
