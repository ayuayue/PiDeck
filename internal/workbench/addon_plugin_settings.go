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

// normalizePluginSettings checks a plugin's settings and returns the keys
// it declared.
func normalizePluginSettings(p *plugin) map[string]bool {
	declared := map[string]bool{}
	var out []pluginSetting
	for _, s := range p.Contributes.Settings {
		s.Key = strings.TrimSpace(s.Key)
		s.Label = strings.TrimSpace(s.Label)
		s.Type = strings.ToLower(strings.TrimSpace(s.Type))
		if s.Type == "" {
			s.Type = "string"
		}
		switch {
		case s.Key == "" || s.Label == "":
			p.Warnings = append(p.Warnings, "跳过没有 key 或标题的设置")
			continue
		case !pluginSettingKey.MatchString(s.Key):
			p.Warnings = append(p.Warnings, "设置 key 只能用字母、数字、下划线、点和横线："+s.Key)
			continue
		case declared[s.Key]:
			p.Warnings = append(p.Warnings, "跳过重复的设置 key："+s.Key)
			continue
		}
		switch s.Type {
		case "bool", "string", "number":
		case "select":
			if len(s.Options) == 0 {
				p.Warnings = append(p.Warnings, "设置 "+s.Key+" 是 select，但没有 options")
				continue
			}
			def := settingText(s.Default)
			if def == "" {
				s.Default = s.Options[0]
				def = s.Options[0]
			}
			known := false
			for _, opt := range s.Options {
				if opt == def {
					known = true
				}
			}
			if !known {
				p.Warnings = append(p.Warnings, "设置 "+s.Key+" 的默认值不在 options 里，改用 "+s.Options[0]+"："+def)
				s.Default = s.Options[0]
			}
		default:
			p.Warnings = append(p.Warnings, fmt.Sprintf("设置 %s 的类型 %q 不认识", s.Key, s.Type))
			continue
		}
		declared[s.Key] = true
		out = append(out, s)
	}
	p.Contributes.Settings = out
	return declared
}

// settingText renders a setting's default as the stored form.
func settingText(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case bool:
		if x {
			return "true"
		}
		return "false"
	case string:
		return x
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	return fmt.Sprint(v)
}

// pluginSettingValue is the saved value of one setting, or its default.
func pluginSettingValue(saved map[string]string, p plugin, key string) string {
	if saved != nil {
		if v, ok := saved[p.ID+"/"+key]; ok {
			return v
		}
	}
	for _, s := range p.Contributes.Settings {
		if s.Key == key {
			return settingText(s.Default)
		}
	}
	return ""
}

// pluginSetting reads one of a plugin's settings.
func (a *app) pluginSetting(id, key string) string {
	if a.plugins == nil {
		return pluginSettingValue(a.cfg.PluginSettings, plugin{ID: id}, key)
	}
	for _, p := range a.plugins.GetUntracked() {
		if p.ID == id {
			return pluginSettingValue(a.cfg.PluginSettings, p, key)
		}
	}
	return pluginSettingValue(a.cfg.PluginSettings, plugin{ID: id}, key)
}

// setPluginSetting stores one setting and redraws the settings page.
func (a *app) setPluginSetting(id, key, value string) {
	if a.st == nil {
		return
	}
	a.st.edit(func(c *config) {
		if c.PluginSettings == nil {
			c.PluginSettings = map[string]string{}
		}
		c.PluginSettings[id+"/"+key] = value
	})
	a.cfg = a.st.config()
}

// expandPluginText fills a plugin action's ${setting:key} references.
func (a *app) expandPluginText(p plugin, text string) string {
	if !strings.Contains(text, "${setting:") {
		return text
	}
	return pluginSettingRef.ReplaceAllStringFunc(text, func(m string) string {
		return pluginSettingValue(a.cfg.PluginSettings, p, pluginSettingRef.FindStringSubmatch(m)[1])
	})
}
