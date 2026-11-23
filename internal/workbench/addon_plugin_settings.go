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
	"math"
	"strconv"
	"strings"
	"sync"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/ui"
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
			valid := false
			switch s.Type {
			case "bool":
				if s.Default == nil {
					s.Default = false
				}
				_, valid = s.Default.(bool)
			case "string":
				if s.Default == nil {
					s.Default = ""
				}
				_, valid = s.Default.(string)
			case "number":
				if s.Default == nil {
					s.Default = 0
				}
				switch s.Default.(type) {
				case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
					valid = pluginSettingAccepts(s, settingText(s.Default))
				}
			}
			if !valid {
				p.Warnings = append(p.Warnings, apptext.T("设置 %s 的默认值与类型 %s 不匹配，已跳过。", s.Key, s.Type))
				continue
			}
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

// pluginSettingAccepts checks the persisted string against its declaration.
// Numbers must be finite; select values must belong to the current options.
func pluginSettingAccepts(s pluginSetting, value string) bool {
	switch s.Type {
	case "bool":
		return value == "true" || value == "false"
	case "number":
		n, err := strconv.ParseFloat(value, 64)
		return err == nil && !math.IsNaN(n) && !math.IsInf(n, 0)
	case "select":
		for _, opt := range s.Options {
			if value == opt {
				return true
			}
		}
		return false
	case "", "string":
		return true
	}
	return false
}

// pluginSettingValue reads only declared keys. An invalid saved value falls
// back to the normalized default without rewriting the user's configuration.
func pluginSettingValue(saved map[string]string, p plugin, key string) string {
	if p.Error != "" {
		return ""
	}
	for _, s := range p.Contributes.Settings {
		if s.Key == key {
			if v, ok := saved[p.ID+"/"+key]; ok && pluginSettingAccepts(s, v) {
				return v
			}
			return settingText(s.Default)
		}
	}
	return ""
}

// pluginSetting reads one of a plugin's settings.
func (a *app) pluginSetting(id, key string) string {
	if p := a.installedPlugin(id); p != nil {
		return pluginSettingValue(a.cfg.PluginSettings, *p, key)
	}
	return ""
}

// setPluginSetting accepts only values allowed by a loaded declaration.
func (a *app) setPluginSetting(id, key, value string) bool {
	if a.st == nil {
		return false
	}
	p := a.installedPlugin(id)
	if p == nil || p.Error != "" {
		return false
	}
	valid := false
	for _, s := range p.Contributes.Settings {
		if s.Key == key {
			valid = pluginSettingAccepts(s, value)
			break
		}
	}
	if !valid {
		return false
	}
	a.st.change(func(c *config) {
		if c.PluginSettings == nil {
			c.PluginSettings = map[string]string{}
		}
		c.PluginSettings[id+"/"+key] = value
	})
	a.cfg = a.st.config()
	a.savePluginConfig()
	return true
}

// Shutdown waits for accepted plugin configuration writes before exiting.
var pluginConfigWrites sync.WaitGroup

// Plugin settings and the last accepted index URL share the existing store.
// Only the in-memory change runs on the graph; file IO runs behind its write
// lock, and failures are returned to the live UI scope.
func (a *app) savePluginConfig() {
	st := a.st
	pluginConfigWrites.Add(1)
	go func() {
		defer pluginConfigWrites.Done()
		if err := st.save(); err != nil {
			a.cx.Post(func() { a.toast(ui.ToastError, "保存失败", err.Error()) })
		}
	}()
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
