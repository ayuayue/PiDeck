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
	"reflect"
	"strings"
	"time"

	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
)

// applyTheme gives the window its look: the appearance, then the palette
// and tokens over the app's own.
func (a *app) applyTheme() {
	name := a.theme.GetUntracked()
	spec := a.themeSpec(name)
	// The side: a theme that names one owns it, then the side the look
	// button pinned, then the 纸白/炭黑 pair, and otherwise the system's.
	// The palette always comes from the theme, so flipping 羊皮纸 to its
	// dark side keeps 羊皮纸's colors.
	side := ""
	if spec != nil {
		side = spec.Appearance
	}
	if side != "light" && side != "dark" {
		side = a.cfg.Appearance
	}
	switch {
	case side == "light":
		a.cx.SetAppearance(core.AppearanceLight)
	case side == "dark":
		a.cx.SetAppearance(core.AppearanceDark)
	case name == "light":
		a.cx.SetAppearance(core.AppearanceLight)
	case name == "dark":
		a.cx.SetAppearance(core.AppearanceDark)
	default:
		a.cx.SetAppearance(core.AppearanceSystem)
	}
	base := viewkit.Theme()
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
			if f := strings.TrimSpace(spec.Tokens["font-sans"]); f != "" {
				base.Sans = f
			}
			if f := strings.TrimSpace(spec.Tokens["font-mono"]); f != "" {
				base.Mono = f
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
	if f := strings.TrimSpace(a.cfg.UIFont); f != "" {
		base.Sans = f
	}
	if f := strings.TrimSpace(a.cfg.MonoFont); f != "" {
		base.Mono = f
	}
	// Class-based UI and explicit code styles resolve the same effective
	// font. A theme token must not override the user's font preference.
	base.Tokens["font-sans"], base.Tokens["font-mono"] = base.Sans, base.Mono
	// Every view that names a monospaced family goes through monoFont, so
	// the setting reaches the app's own text as the theme's does.
	viewkit.MonoFamily = base.Mono
	if viewkit.MonoFamily == "" {
		viewkit.MonoFamily = core.FontMonospace
	}
	if a.cfg.wallpaper() != "" {
		// PiDeck's wallpaper mode: panels show the picture through them at a
		// fixed alpha, and the veil alone follows the opacity setting, so
		// dragging that slider never has to swap the theme (which would end
		// the drag under the pointer).
		const panel = float32(0.3)
		for _, p := range []*core.Palette{&base.Light, &base.Dark} {
			p.Background = withAlpha(p.Background, panel)
			p.Surface = withAlpha(p.Surface, panel)
			p.SurfaceHover = withAlpha(p.SurfaceHover, min(1, panel+0.08))
			p.SurfacePressed = withAlpha(p.SurfacePressed, min(1, panel+0.12))
			for name, alpha := range map[string]float32{"inset": panel, "raised": min(1, panel+0.05), "field": min(1, panel+0.20)} {
				if c, ok := p.Color(name); ok {
					p.SetColor(name, withAlpha(c, alpha))
				}
			}
		}
	}
	// The SDK follows theme identity. Replacing an equal theme after a
	// background environment/add-on probe would rebuild themed regions,
	// discarding focus and in-flight pointer targets despite no visual
	// change. Compare with the published theme without tracking this read.
	unchanged := false
	a.cx.Untrack(func() { unchanged = reflect.DeepEqual(a.cx.Theme(), base) })
	if !unchanged {
		a.cx.SetTheme(base)
	}
}

// backgroundOpacity is how much of the background picture shows, 0.8
// while unset.
func (a *app) backgroundOpacity() float64 {
	if a.cfg.BackgroundOpacity != nil {
		return min(1, max(0, *a.cfg.BackgroundOpacity))
	}
	return 0.8
}

// withAlpha keeps a color's channels and gives it alpha.
func withAlpha(c core.Color, alpha float32) core.Color {
	r, g, b, _ := c.Components()
	return core.RGBA(uint32(r*255+0.5)<<16|uint32(g*255+0.5)<<8|uint32(b*255+0.5), alpha)
}

// setBackgroundImage stores the picture behind the app and applies its
// transparency.
func (a *app) setBackgroundImage(path string) {
	path = strings.TrimSpace(path)
	if wallpaperVideo(path) {
		a.cfg.BackgroundVideo, a.cfg.BackgroundImage = path, ""
	} else {
		a.cfg.BackgroundImage, a.cfg.BackgroundVideo = path, ""
	}
	if path == "" {
		a.cfg.BackgroundOpacity = nil
	} else if a.cfg.BackgroundOpacity == nil {
		v := 0.8
		a.cfg.BackgroundOpacity = &v
	}
	a.bgImage.Set(path)
	a.bgOpacity.Set(a.backgroundOpacity())
	a.bumpSettings()
	if a.st != nil {
		image, video, opacity := a.cfg.BackgroundImage, a.cfg.BackgroundVideo, a.cfg.BackgroundOpacity
		a.st.edit(func(c *config) {
			c.BackgroundImage, c.BackgroundVideo = image, video
			if opacity == nil {
				c.BackgroundOpacity = nil
			} else {
				v := *opacity
				c.BackgroundOpacity = &v
			}
		})
	}
	a.applyTheme()
}

// setBackgroundOpacity stores how much of the picture shows. The veil reads
// the signal, so the picture follows the slider as it moves; only the file
// write waits for the value to rest.
func (a *app) setBackgroundOpacity(v float64) {
	v = min(1, max(0, v))
	a.cfg.BackgroundOpacity = &v
	a.bgOpacity.Set(v)
	a.bgOpacitySeq++
	seq := a.bgOpacitySeq
	a.cx.AfterFunc(300*time.Millisecond, func() {
		if a.bgOpacitySeq != seq || a.st == nil {
			return // still moving: the last value will be kept
		}
		a.st.edit(func(c *config) {
			vv := v
			c.BackgroundOpacity = &vv
		})
	})
}

// applyFonts applies the custom families to the interface, the editor and
// the theme's tokens.
func (a *app) applyFonts() {
	a.uiFont.Set(strings.TrimSpace(a.cfg.UIFont))
	a.monoFont.Set(strings.TrimSpace(a.cfg.MonoFont))
	a.chatFont.Set(a.cfg.ChatFont)
	a.chatLine.Set(a.cfg.ChatLine)
	a.inputFont.Set(a.cfg.InputFont)
	a.applyTheme()
}
