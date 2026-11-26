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

// builtinPalette names each tone so the two appearances can tune their
// depth, states and semantic colors independently.
type builtinPalette struct {
	background, inset, surface, raised, field      string
	hover, pressed, text, muted, faint             string
	border, line                                   string
	accent, accentHover, accentPressed, onAccent   string
	danger, warning, success, info, thinking, code string
}

func paletteOf(p builtinPalette) map[string]string {
	return map[string]string{
		"background": p.background, "inset": p.inset, "surface": p.surface, "raised": p.raised,
		"field": p.field, "fieldBorder": rgbaOf(p.text, 0.56),
		"surfaceHover": p.hover, "surfacePressed": p.pressed,
		"text": p.text, "textMuted": p.muted, "faint": p.faint,
		"border": p.border, "line": p.line, "edge": rgbaOf(p.text, 0.16),
		"accent": p.accent, "accentHover": p.accentHover, "accentPressed": p.accentPressed,
		"accentText": p.onAccent, "accentFill": p.accent,
		"light": p.text, "onLight": p.background,
		"danger": p.danger, "warning": p.warning, "success": p.success,
		"info": p.info, "thinking": p.thinking, "down": p.danger, "code": p.code,
		"selection": rgbaOf(p.accent, 0.18), "focus": p.accent,
		"scrollbar": rgbaOf(p.text, 0.48), "track": rgbaOf(p.text, 0.48), "knob": p.onAccent,
	}
}

// builtinThemes share role names, not colors: each look has a complete
// light and dark palette. System, light and dark use viewkit's foundation.
func builtinThemes() []themeSpec {
	return []themeSpec{
		{ID: "system", Name: "跟随系统", Builtin: true},
		{ID: "light", Name: "纸白", Builtin: true},
		{ID: "dark", Name: "炭黑", Builtin: true},
		{ID: "fresh-green", Name: "森系绿", Builtin: true, Radius: 10,
			Light: paletteOf(builtinPalette{
				background: "#f5f7f3", inset: "#e8eee4", surface: "#fbfcf8",
				raised: "#ffffff", field: "#f7faf4", hover: "#e2eadc", pressed: "#cfdcc8",
				text: "#263326", muted: "#485b43", faint: "#52624b",
				border: "#c4cfbd", line: "#dde5d8",
				accent: "#42623b", accentHover: "#385633", accentPressed: "#2d4529", onAccent: "#ffffff",
				danger: "#973f34", warning: "#785824", success: "#3f6338",
				info: "#3f6276", thinking: "#64556f", code: "#36532f",
			}),
			Dark: paletteOf(builtinPalette{
				background: "#171d18", inset: "#111712", surface: "#202a21",
				raised: "#2b362b", field: "#1b241c", hover: "#2f3e30", pressed: "#3a4c3a",
				text: "#e8eee3", muted: "#becdb7", faint: "#adbea3",
				border: "#465b43", line: "#304230",
				accent: "#a9c697", accentHover: "#c5dcb7", accentPressed: "#91b580", onAccent: "#1b2c19",
				danger: "#e7aa9c", warning: "#dac08a", success: "#b3cea1",
				info: "#abc5cf", thinking: "#cbbbd7", code: "#c4d8b3",
			})},
		{ID: "graphite", Name: "石墨灰", Builtin: true, Radius: 6,
			Light: paletteOf(builtinPalette{
				background: "#f2f3f4", inset: "#e5e7e9", surface: "#fcfcfd",
				raised: "#ffffff", field: "#f8f9fa", hover: "#e1e4e7", pressed: "#d1d6da",
				text: "#272b30", muted: "#4b525b", faint: "#535c65",
				border: "#c5cad0", line: "#dee2e6",
				accent: "#424b55", accentHover: "#333c46", accentPressed: "#252d35", onAccent: "#ffffff",
				danger: "#9d3540", warning: "#73551d", success: "#36624d",
				info: "#345f7d", thinking: "#62527e", code: "#37414b",
			}),
			Dark: paletteOf(builtinPalette{
				background: "#1a1c20", inset: "#14161a", surface: "#23262c",
				raised: "#2c3037", field: "#1e2126", hover: "#30353d", pressed: "#3a414b",
				text: "#e8ebf0", muted: "#b8c0ca", faint: "#a8b1bd",
				border: "#4a515d", line: "#343943",
				accent: "#cdd5e0", accentHover: "#e8edf4", accentPressed: "#afbac9", onAccent: "#20252d",
				danger: "#eba5af", warning: "#dac38d", success: "#a1c5b0",
				info: "#aec6de", thinking: "#c4b8dd", code: "#d2dae5",
			})},
		{ID: "sea-blue", Name: "海盐蓝", Builtin: true, Radius: 10,
			Light: paletteOf(builtinPalette{
				background: "#f3f7fa", inset: "#e5edf3", surface: "#fbfdfe",
				raised: "#ffffff", field: "#f7fbfd", hover: "#e0eaf2", pressed: "#cddde9",
				text: "#223646", muted: "#435c70", faint: "#4b6173",
				border: "#becedb", line: "#dce6ee",
				accent: "#35617f", accentHover: "#2a506b", accentPressed: "#213e54", onAccent: "#ffffff",
				danger: "#a13e43", warning: "#7c591f", success: "#35664f",
				info: "#345d83", thinking: "#655780", code: "#28546c",
			}),
			Dark: paletteOf(builtinPalette{
				background: "#131e28", inset: "#0f1922", surface: "#1a2a36",
				raised: "#243643", field: "#162430", hover: "#263c4d", pressed: "#304a5d",
				text: "#e6eff6", muted: "#b6ccd9", faint: "#a2bfce",
				border: "#3d596e", line: "#2b4254",
				accent: "#9ac4de", accentHover: "#bcdced", accentPressed: "#80aec9", onAccent: "#132938",
				danger: "#f1afab", warning: "#e6c88e", success: "#a0cdb6",
				info: "#a6cdeb", thinking: "#c9bce5", code: "#b9dbe9",
			})},
		{ID: "parchment", Name: "羊皮纸", Builtin: true, Radius: 6,
			Light: paletteOf(builtinPalette{
				background: "#f4f0e6", inset: "#e7dfce", surface: "#faf7f0",
				raised: "#fffdf8", field: "#fcfaf4", hover: "#e8e0d1", pressed: "#daceb9",
				text: "#352d25", muted: "#5c4f3e", faint: "#625542",
				border: "#c9bca6", line: "#e0d5c2",
				accent: "#88462f", accentHover: "#7f402a", accentPressed: "#653320", onAccent: "#fffaf0",
				danger: "#9b352b", warning: "#705019", success: "#465d37",
				info: "#385969", thinking: "#684d6b", code: "#74462e",
			}),
			Dark: paletteOf(builtinPalette{
				background: "#211e19", inset: "#191712", surface: "#2a261f",
				raised: "#353026", field: "#242019", hover: "#393228", pressed: "#463d2f",
				text: "#f0e7d5", muted: "#ccbea7", faint: "#baaa8e",
				border: "#5a4f3d", line: "#3b3429",
				accent: "#e1aa86", accentHover: "#f1c3a3", accentPressed: "#cc9270", onAccent: "#2b2017",
				danger: "#eaa79a", warning: "#debf7b", success: "#b4c39b",
				info: "#adcad2", thinking: "#cdb8cf", code: "#e9c39b",
			})},
		{ID: "tui", Name: "终端（TUI）", Builtin: true, Radius: 4,
			Light: paletteOf(builtinPalette{
				background: "#f1f5f5", inset: "#e0e8e8", surface: "#fafcfc",
				raised: "#ffffff", field: "#f6fafa", hover: "#dce8e8", pressed: "#c8dbda",
				text: "#1c3336", muted: "#405a5d", faint: "#476163",
				border: "#b6caca", line: "#d6e1e1",
				accent: "#22656b", accentHover: "#1b5257", accentPressed: "#143f43", onAccent: "#ffffff",
				danger: "#a13b36", warning: "#7b5617", success: "#37654e",
				info: "#2c5f82", thinking: "#66517a", code: "#1a6065",
			}),
			Dark: paletteOf(builtinPalette{
				background: "#121a1d", inset: "#0c1215", surface: "#192429",
				raised: "#233137", field: "#101a1e", hover: "#22363c", pressed: "#2b454a",
				text: "#dbebea", muted: "#a7c5c5", faint: "#90b3b4",
				border: "#3b5a60", line: "#294046",
				accent: "#89d2ce", accentHover: "#b1e7e0", accentPressed: "#71bbb8", onAccent: "#0c2426",
				danger: "#f0a8a0", warning: "#dfc38c", success: "#a7ccab",
				info: "#a2cde6", thinking: "#c5b6de", code: "#dfc38c",
			})},
	}
}
