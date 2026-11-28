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
	"path/filepath"
	"strings"

	"example.com/pideck/internal/apptext"
)

// appEvents are the events a plugin hook may listen to.
var appEvents = map[string]bool{
	eventTurnStart:      true,
	eventTurnDone:       true,
	eventSessionCreated: true,
	eventSessionOpened:  true,
	eventSessionDeleted: true,
	eventThemeChanged:   true,
	eventPlanFinished:   true,
	eventGitCommit:      true,
	eventImageGenerated: true,
}

// normalizePluginAgents checks a plugin's agents: an id safe to keep in a
// config, a name and a prompt, at most 20.
func normalizePluginAgents(p *plugin) {
	if len(p.Contributes.Agents) == 0 {
		return
	}
	seen := map[string]bool{}
	var out []agentPersona
	for _, agent := range p.Contributes.Agents {
		agent.ID = strings.TrimSpace(agent.ID)
		agent.Name = strings.TrimSpace(agent.Name)
		agent.Description = strings.TrimSpace(agent.Description)
		agent.Prompt = strings.TrimSpace(agent.Prompt)
		if agent.ID == "" || agent.Name == "" || agent.Prompt == "" || !pluginSettingKey.MatchString(agent.ID) || seen[agent.ID] {
			p.Warnings = append(p.Warnings, "跳过无效的智能体："+firstNonEmpty(agent.ID, agent.Name))
			continue
		}
		seen[agent.ID] = true
		out = append(out, agent)
		if len(out) >= 20 {
			break
		}
	}
	p.Contributes.Agents = out
}

// normalizePluginHooks checks a plugin's hooks: a known event, and an
// action that cannot start another turn.
func normalizePluginHooks(p *plugin) {
	if len(p.Contributes.Hooks) == 0 {
		return
	}
	out := map[string][]pluginAction{}
	for name, actions := range p.Contributes.Hooks {
		name = strings.TrimSpace(name)
		if !appEvents[name] {
			p.Warnings = append(p.Warnings, "跳过不认识的事件："+name)
			continue
		}
		if len(actions) > 20 {
			p.Warnings = append(p.Warnings, fmt.Sprintf("事件 %s 的动作超过 20 个，只保留前 20 个", name))
			actions = actions[:20]
		}
		var kept []pluginAction
		for _, a := range actions {
			switch a.Type {
			case "url", "command", "theme":
			default:
				p.Warnings = append(p.Warnings, fmt.Sprintf("事件 %s 只允许 url / command / theme 动作，跳过 %q", name, a.Type))
				continue
			}
			if err := validateAction(a); err != nil {
				p.Warnings = append(p.Warnings, fmt.Sprintf("事件 %s：%v", name, err))
				continue
			}
			if a.Type == "command" && !pluginSettingRef.MatchString(a.Command) && !pluginEventRef.MatchString(a.Command) && !pluginHookCommandAllowed(a.Command) {
				p.Warnings = append(p.Warnings, apptext.T("事件 %s 不允许执行命令：%s", name, a.Command))
				continue
			}
			kept = append(kept, a)
		}
		if len(kept) > 0 {
			out[name] = kept
		}
	}
	p.Contributes.Hooks = out
}

func pluginHookCommandAllowed(id string) bool {
	for _, command := range builtinCommands() {
		if command.ID == id {
			return command.HookSafe
		}
	}
	return false
}

// validateAction checks a plugin command's action shape.
func validateAction(a pluginAction) error {
	switch a.Type {
	case "", "prompt", "insert":
		if strings.TrimSpace(a.Prompt) == "" {
			return fmt.Errorf("action 需要 prompt")
		}
	case "send":
		if strings.TrimSpace(a.Prompt) == "" {
			return fmt.Errorf("action 需要 prompt")
		}
	case "command":
		if strings.TrimSpace(a.Command) == "" {
			return fmt.Errorf("action 需要 command")
		}
		// References may resolve to a builtin at execution time, but never to
		// a palette route or another plugin (which could recurse or send).
		if !pluginSettingRef.MatchString(a.Command) && !pluginEventRef.MatchString(a.Command) && !isBuiltinCommand(a.Command) {
			return fmt.Errorf("%s", apptext.T("插件只能执行内置命令：%s", a.Command))
		}
	case "url":
		if !strings.HasPrefix(a.URL, "https://") && !strings.HasPrefix(a.URL, "http://") {
			return fmt.Errorf("action.url 只接受 http(s) 链接")
		}
	case "theme":
		if strings.TrimSpace(a.Theme) == "" {
			return fmt.Errorf("action 需要 theme")
		}
	default:
		return fmt.Errorf("不认识的 action 类型 %q", a.Type)
	}
	return nil
}

// resolveInside joins a relative path and refuses anything that leaves
// the plugin's own folder.
func resolveInside(dir, rel string) (string, bool) {
	if dir == "" || rel == "" || filepath.IsAbs(rel) {
		return "", false
	}
	path := filepath.Clean(filepath.Join(dir, rel))
	back, err := filepath.Rel(dir, path)
	if err != nil || back == ".." || strings.HasPrefix(back, ".."+string(filepath.Separator)) {
		return "", false
	}
	return path, true
}
