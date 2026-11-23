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
	"regexp"
)

// plugin is a folder of add-ons.
type plugin struct {
	SchemaVersion int `yaml:"schemaVersion" json:"schemaVersion"`
	// Runtime names the host contract; it is independent of the registry's
	// code-hosting source. Missing identity fields use the legacy V2 v2
	// interpretation without rewriting the user's manifest.
	Runtime     string        `yaml:"runtime" json:"runtime"`
	ID          string        `yaml:"id" json:"id"`
	Name        string        `yaml:"name" json:"name"`
	Version     string        `yaml:"version" json:"version"`
	Description string        `yaml:"description" json:"description"`
	Author      string        `yaml:"author" json:"author"`
	Homepage    string        `yaml:"homepage" json:"homepage"`
	Contributes pluginContrib `yaml:"contributes" json:"contributes"`

	// Prompts and Themes are the older shape: a list of prompt commands
	// and inline themes.
	Prompts []pluginPrompt `yaml:"prompts" json:"prompts"`
	Themes  []themeFile    `yaml:"themes" json:"themes"`

	// Path is the manifest file, Dir the folder a plugin's relative
	// paths resolve in.
	Path string `yaml:"-" json:"-"`
	Dir  string `yaml:"-" json:"-"`
	// manifestRevision ties a file operation to the manifest the user saw.
	manifestRevision string

	// Commands and ThemeSpecs are what the app actually uses: the
	// manifest normalized, legacy entries folded in, bad ones dropped
	// with a warning.
	Commands   []pluginCommand `yaml:"-" json:"-"`
	ThemeSpecs []themeSpec     `yaml:"-" json:"-"`
	Warnings   []string        `yaml:"-" json:"-"`
	// Disabled is the user's choice, kept in the app config.
	Disabled bool   `yaml:"-" json:"-"`
	Error    string `yaml:"-" json:"-"`
}

// pluginContrib is what a plugin adds to the app.
type pluginContrib struct {
	Commands    []pluginCommand    `yaml:"commands" json:"commands"`
	Themes      []string           `yaml:"themes" json:"themes"`
	Keybindings []pluginKeybinding `yaml:"keybindings" json:"keybindings"`
	Settings    []pluginSetting    `yaml:"settings" json:"settings"`
	// Hooks run an action when an app event happens. Only events and
	// actions that cannot start another turn are allowed, so a hook
	// cannot loop.
	Hooks map[string][]pluginAction `yaml:"hooks" json:"hooks"`
	// Agents are ways of working the plugin adds to the agent picker.
	Agents []agentPersona `yaml:"agents" json:"agents"`
}

// pluginSetting is one value a plugin asks the user for. Commands read it
// with ${setting:key}, so a plugin can stay declarative and still be
// configured without editing its file.
type pluginSetting struct {
	Key         string   `yaml:"key" json:"key"`
	Label       string   `yaml:"label" json:"label"`
	Description string   `yaml:"description" json:"description"`
	Type        string   `yaml:"type" json:"type"` // bool, string, number, select
	Default     any      `yaml:"default" json:"default"`
	Options     []string `yaml:"options" json:"options"`
}

// pluginSettingRef matches a setting reference in an action's text.
var pluginSettingRef = regexp.MustCompile(`\$\{setting:([A-Za-z0-9_.-]+)\}`)

// pluginSettingKey is a valid setting key.
var pluginSettingKey = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

// pluginCommand is a palette command a plugin adds.
type pluginCommand struct {
	ID          string       `yaml:"id" json:"id"`
	Title       string       `yaml:"title" json:"title"`
	Description string       `yaml:"description" json:"description"`
	Group       string       `yaml:"group" json:"group"`
	Icon        string       `yaml:"icon" json:"icon"`
	Action      pluginAction `yaml:"action" json:"action"`
}

// pluginAction is what a command does. Only these shapes run; a plugin
// cannot bring its own code.
type pluginAction struct {
	Type    string `yaml:"type" json:"type"`
	Prompt  string `yaml:"prompt" json:"prompt"`
	Command string `yaml:"command" json:"command"`
	URL     string `yaml:"url" json:"url"`
	Theme   string `yaml:"theme" json:"theme"`
}

// pluginKeybinding binds a key to a command. The app binds it after the
// plugins load; a key the app already uses is left alone.
type pluginKeybinding struct {
	Command string `yaml:"command" json:"command"`
	Key     string `yaml:"key" json:"key"`
}

// pluginPrompt is the older shape of a prompt command.
type pluginPrompt struct {
	Title  string `yaml:"title" json:"title"`
	Prompt string `yaml:"prompt" json:"prompt"`
	Group  string `yaml:"group" json:"group"`
}
