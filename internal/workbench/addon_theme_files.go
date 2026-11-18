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
	"strings"

	"github.com/nsgo-dev/nsgo/core"
	yaml "go.yaml.in/yaml/v3"
)

// themesDir and pluginsDir are the folders the app reads.
func (a *app) themesDir() string {
	if a.st == nil {
		return ""
	}
	return filepath.Join(a.st.dir, "themes")
}

func (a *app) pluginsDir() string {
	if a.st == nil {
		return ""
	}
	return filepath.Join(a.st.dir, "plugins")
}

// loadThemes reads the built-in looks, theme files, and themes a plugin
// brings.
func (a *app) loadThemes(plugins []plugin) []themeSpec {
	specs := builtinThemes()
	seen := map[string]bool{"system": true, "light": true, "dark": true}
	if dir := a.themesDir(); dir != "" {
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			if e.IsDir() || !isThemeFile(e.Name()) {
				continue
			}
			path := filepath.Join(dir, e.Name())
			spec, err := parseThemeFile(path, fileBase(e.Name()))
			if err != nil {
				specs = append(specs, themeSpec{ID: "user:" + fileBase(e.Name()), Name: fileBase(e.Name()),
					Source: path, Error: err.Error()})
				continue
			}
			spec.ID = "user:" + firstNonEmpty(spec.ID, fileBase(e.Name()))
			if seen[spec.ID] {
				continue
			}
			seen[spec.ID] = true
			specs = append(specs, spec)
		}
	}
	for _, p := range plugins {
		if p.Disabled {
			continue
		}
		for _, spec := range p.ThemeSpecs {
			if seen[spec.ID] {
				continue
			}
			seen[spec.ID] = true
			specs = append(specs, spec)
		}
	}
	return specs
}

// parseThemeFile reads one theme file in either supported shape.
func parseThemeFile(path, fallbackName string) (themeSpec, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return themeSpec{}, err
	}
	var f themeFile
	if err := yaml.Unmarshal(raw, &f); err != nil {
		return themeSpec{}, err
	}
	spec := themeSpec{
		ID:         strings.TrimSpace(f.ID),
		Name:       firstNonEmpty(f.Name, fallbackName),
		Author:     f.Author,
		Appearance: normalizeAppearance(f.Appearance),
		Light:      f.Light,
		Dark:       f.Dark,
		Tokens:     map[string]string{},
		Sans:       f.Sans,
		Mono:       f.Mono,
		Source:     path,
	}
	if f.Radius != nil {
		spec.Radius = *f.Radius
	}
	for k, v := range f.Tokens {
		spec.Tokens[k] = v
	}
	if len(f.CSSVars.Theme)+len(f.CSSVars.Light)+len(f.CSSVars.Dark) > 0 {
		parsed, err := core.ParseTheme(raw)
		if err != nil {
			return spec, err
		}
		keys := map[string]bool{}
		for _, m := range []map[string]string{f.CSSVars.Theme, f.CSSVars.Light, f.CSSVars.Dark} {
			for k := range m {
				keys[k] = true
			}
		}
		spec.LightColors = map[string]core.Color{}
		spec.DarkColors = map[string]core.Color{}
		for k := range keys {
			if c, ok := parsed.Light.Color(k); ok {
				spec.LightColors[k] = c
			}
			if c, ok := parsed.Dark.Color(k); ok {
				spec.DarkColors[k] = c
			}
		}
		for k, v := range parsed.Tokens {
			if _, set := spec.Tokens[k]; !set {
				spec.Tokens[k] = v
			}
		}
		if spec.Radius == 0 && parsed.Radius != 0 {
			spec.Radius = float32(parsed.Radius)
		}
		if spec.Sans == "" {
			spec.Sans = parsed.Sans
		}
		if spec.Mono == "" {
			spec.Mono = parsed.Mono
		}
	}
	if spec.ID == "" {
		spec.ID = fallbackName
	}
	if spec.Name == "" {
		spec.Name = fallbackName
	}
	return spec, nil
}
