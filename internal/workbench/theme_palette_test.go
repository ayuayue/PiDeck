//go:build !js && !android && !ios

package workbench

import (
	"math"
	"testing"

	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
)

// Exercise the palettes consumed by the app, including inherited roles and
// alpha-composited control outlines, without starting a window or taking shots.
func TestBuiltinThemePalettes(t *testing.T) {
	roles := []string{
		"background", "surface", "surfaceHover", "surfacePressed", "border", "text", "textMuted",
		"accent", "accentHover", "accentPressed", "accentText", "danger", "warning", "success",
		"selection", "focus", "scrollbar", "inset", "raised", "field", "fieldBorder", "line", "edge",
		"faint", "accentFill", "light", "onLight", "track", "knob", "code", "info", "thinking", "down",
	}
	for _, spec := range builtinThemes() {
		base := viewkit.Theme()
		for _, mode := range []struct {
			name  string
			roles map[string]string
			base  core.Palette
		}{{"light", spec.Light, base.Light}, {"dark", spec.Dark, base.Dark}} {
			t.Run(spec.ID+"/"+mode.name, func(t *testing.T) {
				if spec.ID != "system" && spec.ID != "light" && spec.ID != "dark" {
					for _, role := range roles {
						if mode.roles[role] == "" {
							t.Errorf("theme must define its own %s", role)
						}
					}
					if spec.Radius <= 0 || spec.Radius > 16 {
						t.Errorf("invalid theme radius: %v", spec.Radius)
					}
				}
				p := mode.base
				for role, value := range mode.roles {
					c, err := core.ParseColor(value)
					if err != nil {
						t.Fatalf("invalid %s color %q: %v", role, value, err)
					}
					p.SetColor(role, c)
				}
				color := func(role string) core.Color {
					c, ok := p.Color(role)
					if !ok || c == core.Transparent {
						t.Fatalf("missing color role %s", role)
					}
					return c
				}
				for _, role := range roles {
					color(role)
				}
				surfaces := []string{"background", "inset", "surface", "raised", "field", "surfaceHover", "surfacePressed"}
				foregrounds := []string{"text", "textMuted", "faint", "accent", "code", "danger", "warning", "success", "info", "thinking"}
				for _, fg := range foregrounds {
					for _, bg := range surfaces {
						if got := themeContrast(color(fg), color(bg)); got < 4.5 {
							t.Errorf("%s on %s contrast = %.2f, want >= 4.5", fg, bg, got)
						}
					}
				}
				for _, fill := range []string{"accent", "accentHover", "accentPressed"} {
					if got := themeContrast(color("accentText"), color(fill)); got < 4.5 {
						t.Errorf("button text on %s contrast = %.2f, want >= 4.5", fill, got)
					}
				}
				for _, bg := range []string{"background", "surface", "field"} {
					if got := themeContrast(color("focus"), color(bg)); got < 3 {
						t.Errorf("focus on %s contrast = %.2f, want >= 3", bg, got)
					}
				}
				if got := themeContrast(color("fieldBorder"), color("field")); got < 3 {
					t.Errorf("input outline contrast = %.2f, want >= 3", got)
				}
				if p.Accent == p.AccentHover || p.AccentHover == p.AccentPressed || p.Accent == p.AccentPressed {
					t.Error("primary action needs distinct resting, hover and pressed colors")
				}
				if p.SurfaceHover == p.SurfacePressed {
					t.Error("surface hover and pressed colors must differ")
				}
				if color("field") == color("raised") {
					t.Error("input and elevated panels must have separate tones")
				}
			})
		}
	}
}

// Color.Components uses normalized sRGB channels. Composite translucent
// foregrounds before calculating WCAG relative luminance.
func themeContrast(foreground, background core.Color) float64 {
	r, g, b, a := foreground.Components()
	br, bg, bb, _ := background.Components()
	linear := func(v float64) float64 {
		if v <= 0.04045 {
			return v / 12.92
		}
		return math.Pow((v+0.055)/1.055, 2.4)
	}
	luminance := func(r, g, b float64) float64 {
		return 0.2126*linear(r) + 0.7152*linear(g) + 0.0722*linear(b)
	}
	f := luminance(float64(r*a+br*(1-a)), float64(g*a+bg*(1-a)), float64(b*a+bb*(1-a)))
	back := luminance(float64(br), float64(bg), float64(bb))
	return (math.Max(f, back) + 0.05) / (math.Min(f, back) + 0.05)
}
