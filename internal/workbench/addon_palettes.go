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
	"strconv"
	"strings"
)

// rgbaOf writes a hex color with alpha for a theme role.
func rgbaOf(hex string, alpha float64) string {
	hex = strings.TrimPrefix(strings.TrimSpace(hex), "#")
	if len(hex) != 6 {
		return hex
	}
	r, _ := strconv.ParseUint(hex[0:2], 16, 8)
	g, _ := strconv.ParseUint(hex[2:4], 16, 8)
	b, _ := strconv.ParseUint(hex[4:6], 16, 8)
	return fmt.Sprintf("rgba(%d, %d, %d, %.2f)", r, g, b, alpha)
}

// paletteOf maps a look's surfaces, ink and accent to the palette roles
// the app reads. Semantic colors follow the app's own.
func paletteOf(bg, side, panel, input, hover, active, text, muted, faint, border, line, accent, strong, accentText, code string) map[string]string {
	return map[string]string{
		"background": bg, "inset": side, "surface": panel, "raised": panel,
		"field": input, "fieldBorder": border, "surfaceHover": hover, "surfacePressed": active,
		"text": text, "textMuted": muted, "faint": faint, "border": border, "line": line,
		"accent": accent, "accentHover": strong, "accentPressed": strong, "accentText": accentText,
		"accentFill": accent, "light": text, "onLight": accentText, "code": code,
		"selection": rgbaOf(accent, 0.20), "focus": rgbaOf(accent, 0.45), "scrollbar": rgbaOf(text, 0.22),
	}
}

// builtinThemes are the looks the app ships with, matching PiDeck's
// palettes.
func builtinThemes() []themeSpec {
	return []themeSpec{
		{ID: "system", Name: "跟随系统", Builtin: true},
		{ID: "light", Name: "纸白", Builtin: true},
		{ID: "dark", Name: "炭黑", Builtin: true},
		{ID: "fresh-green", Name: "森系绿", Builtin: true,
			Light: paletteOf("#f6f7f2", "#ecefe6", "#f6f7f2", "#e7ebe0", "#dadece", "#c9d0be",
				"#273529", "#4b5744", "#8d998e", "#c8cfbf", "#d4dacd", "#4a7854", "#3f6347", "#ffffff", "#36593d"),
			Dark: paletteOf("#151917", "#212724", "#1d2420", "#212724", "#313f38", "#36443d",
				"#e9edea", "#b2bdb6", "#8ea294", "#384740", "#2f3a34", "#55906c", "#66a380", "#101512", "#2dd4bf")},
		{ID: "graphite", Name: "石墨灰", Builtin: true,
			Light: paletteOf("#ececec", "#e3e3e3", "#f8f8f8", "#fafafa", "#e9e9e9", "#dedede",
				"#1f1f22", "#4a4a4d", "#8f8f8b", "#d0d0d0", "#d8d8d8", "#18181b", "#09090b", "#ffffff", "#373737"),
			Dark: paletteOf("#1b1b1b", "#222222", "#262626", "#262626", "#303030", "#383838",
				"#ecece7", "#b8b8b2", "#9a9a94", "#444444", "#3a3a3a", "#e7e7e7", "#ffffff", "#121212", "#d6d6d6")},
		{ID: "sea-blue", Name: "海盐蓝", Builtin: true,
			Light: paletteOf("#eef5fb", "#e4eef7", "#ffffff", "#ffffff", "#e8f0f7", "#dfeaf3",
				"#1c2e3d", "#3f586b", "#8a97a8", "#d3e1ec", "#dbe7f0", "#2563eb", "#1d4ed8", "#ffffff", "#373737"),
			Dark: paletteOf("#101a24", "#15212d", "#182634", "#182634", "#21303f", "#2a3a4b",
				"#e7eef6", "#b6c5d4", "#8ba0b3", "#36495c", "#2c3d4e", "#60a5fa", "#3b82f6", "#0b1420", "#d6e2ee")},
		{ID: "parchment", Name: "羊皮纸", Builtin: true,
			Light: paletteOf("#f5f4ed", "#ece9df", "#faf9f5", "#faf9f5", "#eae7dc", "#dedacb",
				"#141413", "#3d3d3a", "#87867f", "#dcd8ca", "#e8e5d9", "#b0562f", "#96482a", "#fffaf4", "#8a3f24"),
			Dark: paletteOf("#141413", "#1b1a17", "#23221e", "#23221e", "#33302a", "#3c382f",
				"#f3eee2", "#c6c0b1", "#938d7f", "#3c3830", "#302d26", "#c96442", "#d97757", "#141413", "#e9a887")},
		{ID: "tui", Name: "终端（TUI）", Builtin: true,
			Light: paletteOf("#efeeee", "#e9e8e8", "#f7f6f6", "#ecebeb", "#e9e9e9", "#dfe7ec",
				"#3b3f41", "#5f686d", "#879095", "#9aa2a7", "#dcdcdc", "#7459b4", "#5f47a0", "#ffffff", "#6f55ad"),
			Dark: paletteOf("#21252c", "#1b1f25", "#282c34", "#1d2127", "#30363e", "#213b49",
				"#dee0e1", "#9da5a9", "#707a80", "#6b767c", "#34383a", "#a798d7", "#b7a7e6", "#1a1724", "#a798d7")},
	}
}
