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
	"os"
	"path/filepath"
)

// ensureAddonDirs makes the folders the app documents and seeds a theme
// and an agent. Plugin examples are installed explicitly in the market.
func (a *app) ensureAddonDirs() {
	if a.st == nil {
		return
	}
	if dir := a.themesDir(); dir != "" {
		_ = os.MkdirAll(dir, 0o755)
		example := filepath.Join(dir, "example.json")
		if _, err := os.Stat(example); os.IsNotExist(err) {
			_ = writeFileAtomic(example, []byte(`{
  "name": "雾蓝",
  "author": "你",
  "appearance": "both",
  "radius": 10,
  "light": {"background": "#f7f9fc", "inset": "#eef2f8", "border": "rgba(15, 23, 42, 0.12)"},
  "dark":  {"background": "#0f1419", "inset": "#151d24", "accent": "#7aa2f7"}
}
`), 0o644)
		}
	}
	if dir := a.agentsDir(); dir != "" {
		_ = os.MkdirAll(dir, 0o755)
		example := filepath.Join(dir, "example.json")
		if _, err := os.Stat(example); os.IsNotExist(err) {
			_ = writeFileAtomic(example, []byte(`{
  "agents": [
    {
      "id": "security",
      "name": "安全审查",
      "description": "从输入边界、权限与依赖看风险。",
      "prompt": "你是一名安全审查者。先看输入边界与权限，再看依赖与敏感数据流；每个风险给出触发条件与最小修复。"
    }
  ]
}
`), 0o644)
		}
	}
	if dir := a.pluginsDir(); dir != "" {
		_ = os.MkdirAll(dir, 0o755)
	}
}
