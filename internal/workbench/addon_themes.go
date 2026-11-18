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

	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// piScanEvery is how many seconds between two background passes over pi's
// session store. A pass reads no file that did not change, so it is a few
// stats per session, and a session started in a terminal shows up within
// this many seconds.
const piScanEvery = 20

// themeSpec is one look: the built-in ones, or a file of roles over them.
type themeSpec struct {
	ID         string
	Name       string
	Author     string
	Appearance string // "", "light", "dark" or "both"
	Builtin    bool
	// Light and Dark map palette role names (background, surface, text,
	// accent, inset…) to CSS colors.
	Light map[string]string
	Dark  map[string]string
	// LightColors and DarkColors carry roles parsed from a shadcn/ui
	// theme file, whose values may name other variables.
	LightColors map[string]core.Color
	DarkColors  map[string]core.Color
	// Tokens are the design tokens that are not colors ("radius",
	// "font-sans", "font-mono", and any the app reads by name).
	Tokens map[string]string
	Radius float32
	Sans   string
	Mono   string
	Source string
	Error  string
}

// themeFile is a theme's file: a name and the roles it sets. It reads
// both the app's own shape and a shadcn/ui theme file, JSON or YAML.
type themeFile struct {
	ID         string            `yaml:"id"`
	Name       string            `yaml:"name"`
	Author     string            `yaml:"author"`
	Appearance string            `yaml:"appearance"`
	Radius     *float32          `yaml:"radius"`
	Sans       string            `yaml:"sans"`
	Mono       string            `yaml:"mono"`
	Light      map[string]string `yaml:"light"`
	Dark       map[string]string `yaml:"dark"`
	Tokens     map[string]string `yaml:"tokens"`
	CSSVars    struct {
		Theme map[string]string `yaml:"theme"`
		Light map[string]string `yaml:"light"`
		Dark  map[string]string `yaml:"dark"`
	} `yaml:"cssVars"`
}

// swatch is the color a theme is shown by in the picker.
func (t themeSpec) swatch() core.Color {
	roles := t.Light
	if t.Appearance == "dark" || (t.Appearance != "light" && t.ID == "dark") {
		roles = t.Dark
	}
	for _, name := range []string{"accent", "background", "surface"} {
		if c, ok := t.DarkColors[name]; ok && roles != nil {
			return c
		}
		if c, ok := t.LightColors[name]; ok {
			if t.Appearance != "dark" {
				return c
			}
		}
		if v, ok := roles[name]; ok {
			if c, err := core.ParseColor(v); err == nil {
				return c
			}
		}
	}
	switch t.ID {
	case "dark":
		return core.RGB(0x121212)
	case "light":
		return core.RGB(0xffffff)
	}
	return core.RGBA(0x0d0d0d, 0.35)
}

// previewColor is one role of a theme, from the side it shows, falling
// back to the app's own palette.
func (t themeSpec) previewColor(name string) core.Color {
	dark := t.Appearance == "dark" || (t.Appearance != "light" && t.ID == "dark")
	if dark {
		if c, ok := t.DarkColors[name]; ok {
			return c
		}
		if v, ok := t.Dark[name]; ok {
			if c, err := core.ParseColor(v); err == nil {
				return c
			}
		}
	} else {
		if c, ok := t.LightColors[name]; ok {
			return c
		}
		if v, ok := t.Light[name]; ok {
			if c, err := core.ParseColor(v); err == nil {
				return c
			}
		}
	}
	pal := viewkit.Theme().Light
	if dark {
		pal = viewkit.Theme().Dark
	}
	if c, ok := pal.Color(name); ok {
		return c
	}
	return core.Transparent
}

// themePreview is a theme in miniature: its background, a line of text,
// an accent dot and a danger dot.
func themePreview(t themeSpec) core.Node {
	text := t.previewColor("text")
	return core.View{Style: core.Style{Width: core.Pt(46), Height: core.Pt(26), CornerRadius: 5,
		Background: t.previewColor("background"), BorderWidth: 1, BorderColor: t.previewColor("border")},
		Children: []core.Node{
			core.View{Style: core.Style{Position: core.Absolute, Left: core.Pt(6), Top: core.Pt(6), Width: core.Pt(22), Height: core.Pt(3),
				CornerRadius: 1.5, Background: text}},
			core.View{Style: core.Style{Position: core.Absolute, Left: core.Pt(6), Top: core.Pt(12), Width: core.Pt(14), Height: core.Pt(2),
				CornerRadius: 1, Background: ui.Alpha(text, 0.55)}},
			core.View{Style: core.Style{Position: core.Absolute, Right: core.Pt(6), Bottom: core.Pt(5), Width: core.Pt(6), Height: core.Pt(6),
				CornerRadius: 3, Background: t.previewColor("accent")}},
			core.View{Style: core.Style{Position: core.Absolute, Right: core.Pt(15), Bottom: core.Pt(5), Width: core.Pt(6), Height: core.Pt(6),
				CornerRadius: 3, Background: t.previewColor("danger")}},
		}}
}

// paletteRoleMap writes a palette's roles as a theme file does.
func paletteRoleMap(p core.Palette) map[string]string {
	names := []string{"background", "surface", "surfaceHover", "surfacePressed", "border", "text", "textMuted",
		"accent", "accentHover", "accentPressed", "accentText", "danger", "warning", "success",
		"selection", "focus", "scrollbar"}
	out := map[string]string{}
	for _, name := range names {
		if c, ok := p.Color(name); ok {
			out[name] = colorText(c)
		}
	}
	for name, c := range p.Colors {
		if _, ok := out[name]; !ok {
			out[name] = colorText(c)
		}
	}
	return out
}

// colorText formats a color as #rrggbb, or rgba() when it is translucent.
func colorText(c core.Color) string {
	r, g, b, a := c.Components()
	if a < 0.999 {
		return fmt.Sprintf("rgba(%d,%d,%d,%.2f)", int(r*255+0.5), int(g*255+0.5), int(b*255+0.5), a)
	}
	return fmt.Sprintf("#%02x%02x%02x", int(r*255+0.5), int(g*255+0.5), int(b*255+0.5))
}
