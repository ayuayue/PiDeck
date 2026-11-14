package main

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
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/oneo-me/nsgo/core"
	"github.com/oneo-me/nsgo/ui"
	"go.yaml.in/yaml/v3"
)

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
	pal := pideckTheme().Light
	if dark {
		pal = pideckTheme().Dark
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

// plugin is a folder of add-ons.
type plugin struct {
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

// builtinThemes are the looks the app ships with.
func builtinThemes() []themeSpec {
	return []themeSpec{
		{ID: "system", Name: "跟随系统", Builtin: true},
		{ID: "light", Name: "纸白", Builtin: true},
		{ID: "dark", Name: "炭黑", Builtin: true},
	}
}

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

// loadPlugins reads every plugin under the plugins folder: a folder with
// plugin.json, or a single JSON file. Bad manifests are listed with their
// error rather than dropped, so the settings page can say what is wrong.
func (a *app) loadPlugins() []plugin {
	dir := a.pluginsDir()
	if dir == "" {
		return nil
	}
	disabled := map[string]bool{}
	for _, id := range a.cfg.DisabledPlugins {
		disabled[id] = true
	}
	var out []plugin
	seen := map[string]int{}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		path, folder := "", ""
		if e.IsDir() {
			folder = filepath.Join(dir, e.Name())
			path = filepath.Join(folder, "plugin.json")
		} else if isJSONFile(e.Name()) {
			path = filepath.Join(dir, e.Name())
		} else {
			continue
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			out = append(out, plugin{Name: e.Name(), Path: path, Error: err.Error()})
			continue
		}
		var p plugin
		if err := yaml.Unmarshal(raw, &p); err != nil {
			out = append(out, plugin{Name: e.Name(), Path: path, Error: err.Error()})
			continue
		}
		p.Path = path
		p.Dir = firstNonEmpty(folder, dir)
		if p.Name == "" {
			p.Name = fileBase(e.Name())
		}
		if p.ID == "" {
			p.ID = p.Name
		}
		if n, dup := seen[p.ID]; dup {
			seen[p.ID] = n + 1
			p.ID = fmt.Sprintf("%s-%d", p.ID, n+1)
		} else {
			seen[p.ID] = 1
		}
		p.Disabled = disabled[p.ID]
		normalizePlugin(&p)
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// normalizePlugin folds the older prompts and inline themes into the
// contributes shape and checks each command and theme path.
func normalizePlugin(p *plugin) {
	declared := normalizePluginSettings(p)
	normalizePluginHooks(p)
	normalizePluginAgents(p)
	for i, pr := range p.Prompts {
		if strings.TrimSpace(pr.Title) == "" || strings.TrimSpace(pr.Prompt) == "" {
			continue
		}
		p.Commands = append(p.Commands, pluginCommand{
			ID:          fmt.Sprintf("prompt-%d", i),
			Title:       pr.Title,
			Description: firstLine(pr.Prompt, 70),
			Group:       pr.Group,
			Icon:        "message",
			Action:      pluginAction{Type: "prompt", Prompt: pr.Prompt},
		})
	}
	for i, f := range p.Themes {
		spec := themeSpec{
			ID:         fmt.Sprintf("plugin:%s:%d", p.ID, i),
			Name:       firstNonEmpty(f.Name, fmt.Sprintf("%s %d", p.Name, i+1)),
			Author:     f.Author,
			Appearance: normalizeAppearance(f.Appearance),
			Light:      f.Light,
			Dark:       f.Dark,
			Tokens:     f.Tokens,
		}
		if f.Radius != nil {
			spec.Radius = *f.Radius
		}
		spec.Sans, spec.Mono = f.Sans, f.Mono
		p.ThemeSpecs = append(p.ThemeSpecs, spec)
	}
	ids := map[string]bool{}
	refs := map[string]bool{}
	for _, c := range p.Contributes.Commands {
		c.ID = strings.TrimSpace(c.ID)
		c.Title = strings.TrimSpace(c.Title)
		if c.ID == "" || c.Title == "" {
			p.Warnings = append(p.Warnings, "跳过一条没有 id 或标题的命令")
			continue
		}
		if ids[c.ID] {
			p.Warnings = append(p.Warnings, "跳过重复的命令 id："+c.ID)
			continue
		}
		if err := validateAction(c.Action); err != nil {
			p.Warnings = append(p.Warnings, fmt.Sprintf("命令 %s：%v", c.ID, err))
			continue
		}
		for _, text := range []string{c.Action.Prompt, c.Action.Command, c.Action.URL, c.Action.Theme} {
			for _, m := range pluginSettingRef.FindAllStringSubmatch(text, -1) {
				if declared[m[1]] || refs[c.ID+"/"+m[1]] {
					continue
				}
				refs[c.ID+"/"+m[1]] = true
				p.Warnings = append(p.Warnings, fmt.Sprintf("命令 %s 引用了未声明的设置 %s", c.ID, m[1]))
			}
		}
		ids[c.ID] = true
		p.Commands = append(p.Commands, c)
	}
	for _, rel := range p.Contributes.Themes {
		path, ok := resolveInside(p.Dir, rel)
		if !ok {
			p.Warnings = append(p.Warnings, "跳过插件目录之外的主题："+rel)
			continue
		}
		spec, err := parseThemeFile(path, fileBase(path))
		if err != nil {
			p.Warnings = append(p.Warnings, fmt.Sprintf("主题 %s 读取失败：%v", rel, err))
			continue
		}
		spec.ID = "plugin:" + p.ID + ":" + firstNonEmpty(spec.ID, fileBase(path))
		if spec.Name == "" {
			spec.Name = fileBase(path)
		}
		p.ThemeSpecs = append(p.ThemeSpecs, spec)
	}
}

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
			kept = append(kept, a)
		}
		if len(kept) > 0 {
			out[name] = kept
		}
	}
	p.Contributes.Hooks = out
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

// ensureAddonDirs makes the folders the app documents, with an example
// plugin and theme, so the formats are discoverable.
func (a *app) ensureAddonDirs() {
	if a.st == nil {
		return
	}
	if dir := a.themesDir(); dir != "" {
		_ = os.MkdirAll(dir, 0o755)
		example := filepath.Join(dir, "example.json")
		if _, err := os.Stat(example); os.IsNotExist(err) {
			_ = os.WriteFile(example, []byte(`{
  "name": "雾蓝",
  "author": "你",
  "appearance": "both",
  "radius": 10,
  "light": {"background": "#f7f9fc", "inset": "#eef2f8", "border": "rgba(15, 23, 42, 0.12)"},
  "dark":  {"background": "#0f1419", "inset": "#151d24", "accent": "#7aa2f7"}
}
`), 0o644)
		}
	}
	if dir := a.agentsDir(); dir != "" {
		_ = os.MkdirAll(dir, 0o755)
		example := filepath.Join(dir, "example.json")
		if _, err := os.Stat(example); os.IsNotExist(err) {
			_ = os.WriteFile(example, []byte(`{
  "agents": [
    {
      "id": "security",
      "name": "安全审查",
      "description": "从输入边界、权限与依赖看风险。",
      "prompt": "你是一名安全审查者。先看输入边界与权限，再看依赖与敏感数据流；每个风险给出触发条件与最小修复。"
    }
  ]
}
`), 0o644)
		}
	}
	if dir := a.pluginsDir(); dir != "" {
		_ = os.MkdirAll(dir, 0o755)
		example := filepath.Join(dir, "example-plugin.json")
		if _, err := os.Stat(example); os.IsNotExist(err) {
			_ = os.WriteFile(example, []byte(`{
  "id": "example",
  "name": "示例插件",
  "version": "1.0.0",
  "description": "几条常做的提示词，命令面板里就能直接选用。",
  "contributes": {
    "settings": [
      {"key": "style", "label": "总结风格", "type": "select", "default": "要点", "options": ["要点", "一段话"]}
    ],
    "commands": [
      {
        "id": "review-changes",
        "title": "梳理当前改动",
        "group": "示例插件",
        "icon": "git",
        "action": {"type": "prompt", "prompt": "看看工作区里未提交的改动，用${setting:style}说明它们做了什么、有没有风险。"}
      },
      {
        "id": "open-readme",
        "title": "打开 PiDeck Lite 仓库",
        "group": "示例插件",
        "icon": "globe",
        "action": {"type": "url", "url": "https://github.com/ayuayue/PiDeck-Lite"}
      }
    ]
  }
}
`), 0o644)
		}
	}
}

// applyTheme gives the window its look: the appearance, then the palette
// and tokens over the app's own.
func (a *app) applyTheme() {
	name := a.theme.GetUntracked()
	spec := a.themeSpec(name)
	forced := ""
	if spec != nil {
		forced = spec.Appearance
	}
	switch {
	case forced == "light" || forced == "dark":
		if forced == "light" {
			a.cx.SetAppearance(core.AppearanceLight)
		} else {
			a.cx.SetAppearance(core.AppearanceDark)
		}
	case name == "light":
		a.cx.SetAppearance(core.AppearanceLight)
	case name == "dark":
		a.cx.SetAppearance(core.AppearanceDark)
	default:
		a.cx.SetAppearance(core.AppearanceSystem)
	}
	base := pideckTheme()
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
	a.cx.SetTheme(base)
}

// exportTheme writes the current look as a theme file the app reads back.
func (a *app) exportTheme() {
	dir := a.themesDir()
	if dir == "" {
		a.toast(ui.ToastError, "找不到主题目录", "")
		return
	}
	base := pideckTheme()
	spec := a.themeSpec(a.theme.GetUntracked())
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
	name, appearance := "我的主题", ""
	if spec != nil {
		name = spec.Name + " 副本"
		appearance = spec.Appearance
	}
	id := "exported-" + time.Now().Format("20060102-150405")
	f := themeFile{ID: id, Name: name, Author: "PiDeck Lite", Appearance: appearance,
		Light: paletteRoleMap(base.Light), Dark: paletteRoleMap(base.Dark), Tokens: base.Tokens,
		Sans: base.Sans, Mono: base.Mono}
	if base.Radius > 0 {
		radius := float32(base.Radius)
		f.Radius = &radius
	}
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		a.toast(ui.ToastError, "导出主题失败", err.Error())
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		a.toast(ui.ToastError, "导出主题失败", err.Error())
		return
	}
	path := filepath.Join(dir, id+".json")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		a.toast(ui.ToastError, "导出主题失败", err.Error())
		return
	}
	a.reloadAddons()
	a.toastAction(ui.ToastSuccess, "已导出主题", path, "打开", func() { a.openEditorFile(dir, path) })
}

// themeSpec finds a look by id.
func (a *app) themeSpec(id string) *themeSpec {
	for _, s := range a.themes.GetUntracked() {
		if s.ID == id {
			cp := s
			return &cp
		}
	}
	return nil
}

// themeSpecByName finds a look by display name, for plugin actions that
// name a theme rather than an id.
func (a *app) themeSpecByName(name string) *themeSpec {
	for _, s := range a.themes.GetUntracked() {
		if s.ID == name || s.Name == name {
			cp := s
			return &cp
		}
	}
	return nil
}

// applyRoles sets the palette roles a theme gives.
func applyRoles(p *core.Palette, roles map[string]string) {
	for name, value := range roles {
		c, err := core.ParseColor(value)
		if err != nil {
			continue
		}
		p.SetColor(name, c)
	}
}

// reloadFrameworks reads the environment, the add-ons, and pi's own
// sessions under the projects again, off the UI thread.
func (a *app) reloadFrameworks() {
	if a.st == nil {
		return
	}
	info := a.env.GetUntracked()
	info.Probing = true
	a.env.Set(info)
	dataDir := a.st.dir
	a.addonsGen++
	gen := a.addonsGen
	go func() {
		// This machine first: it is what opening a session needs.
		info := probeLocal(envInfo{AppDir: dataDir, Probing: true, TargetsProbing: true})
		plugins := a.loadPlugins()
		themes := a.loadThemes(plugins)
		providers := probeProviders(info.PiPath, readProviders())
		a.cx.Post(func() {
			a.env.Set(info)
			if gen != a.addonsGen {
				return // a newer reload already answered
			}
			a.plugins.Set(plugins)
			a.themes.Set(themes)
			a.providers.Set(providers)
			a.applyTheme()
			a.applyKeybindings()
			a.reopenSavedTabs()
			a.rescanPi()
		})
		// Other machines take longer; they fill in when they answer.
		info = probeTargets(info)
		a.cx.Post(func() { a.env.Set(info) })
	}()
}

// reloadAddons reads plugins and themes again without probing machines
// or sessions: what the settings page needs after a file changes.
func (a *app) reloadAddons() {
	if a.st == nil {
		return
	}
	a.addonsGen++
	gen := a.addonsGen
	go func() {
		plugins := a.loadPlugins()
		themes := a.loadThemes(plugins)
		a.cx.Post(func() {
			if gen != a.addonsGen {
				return // a newer reload already answered
			}
			a.plugins.Set(plugins)
			a.themes.Set(themes)
			a.applyTheme()
			a.applyKeybindings()
		})
	}()
}

// setPluginEnabled remembers whether a plugin runs and reloads add-ons.
func (a *app) setPluginEnabled(id string, enabled bool) {
	if a.st == nil {
		return
	}
	a.st.edit(func(c *config) {
		var kept []string
		for _, v := range c.DisabledPlugins {
			if v != id {
				kept = append(kept, v)
			}
		}
		if !enabled {
			kept = append(kept, id)
		}
		c.DisabledPlugins = kept
	})
	a.cfg = a.st.config()
	a.reloadAddons()
}

// scanProject reads pi's own sessions for one project, the first time it
// is opened. A project shows its own history, not the whole machine's.
func (a *app) scanProject(ws *workspace) {
	if ws == nil || a.st == nil || ws.Target.remote() || !a.cfg.ScanPi {
		return
	}
	if ws.piLoaded || ws.PiLoading.GetUntracked() {
		return
	}
	root := a.env.GetUntracked().SessionsDir
	if root == "" {
		root = piSessionsDir()
	}
	if root == "" {
		return
	}
	ws.PiLoading.Set(true)
	cwd := filepath.Clean(ws.Path)
	titles := a.cfg.Titles
	go func() {
		metas := a.st.scanPiSessions(root, titles, func(c string) bool { return filepath.Clean(c) == cwd }, 0)
		a.cx.Post(func() {
			ws.piLoaded = true
			list := make([]*session, 0, len(metas))
			for _, m := range metas {
				list = append(list, a.makeSession(m, ws.Target))
			}
			if ws.PiLoading.GetUntracked() || len(ws.Pi.GetUntracked()) != len(list) {
				a.animateNextLayout()
			}
			ws.PiLoading.Set(false)
			ws.Pi.Set(list)
		})
	}()
}

// rescanPi reads pi's own sessions for the projects on screen. It runs
// again when a project is added, so a new folder shows its history at once.
func (a *app) rescanPi() {
	if a.st == nil {
		return
	}
	if !a.cfg.ScanPi {
		for _, ws := range a.workspaces.GetUntracked() {
			ws.Pi.Set(nil)
			ws.PiLoading.Set(false)
		}
		return
	}
	info := a.env.GetUntracked()
	if info.SessionsDir == "" {
		info.SessionsDir = piSessionsDir()
	}
	if info.SessionsDir == "" {
		for _, ws := range a.workspaces.GetUntracked() {
			ws.PiLoading.Set(false)
		}
		return
	}
	// Projects not read yet pulse while the scan runs, so a count that is
	// still unknown does not read as zero.
	for _, ws := range a.workspaces.GetUntracked() {
		if !ws.Target.remote() && !ws.piLoaded {
			ws.PiLoading.Set(true)
		}
	}
	allowed := map[string]bool{}
	for _, ws := range a.workspaces.GetUntracked() {
		if !ws.Target.remote() {
			allowed[filepath.Clean(ws.Path)] = true
		}
	}
	scanAll := a.cfg.ScanAll
	keep := func(cwd string) bool {
		if scanAll {
			return true
		}
		return allowed[filepath.Clean(cwd)]
	}
	titles := a.cfg.Titles
	root := info.SessionsDir
	go func() {
		metas := a.st.scanPiSessions(root, titles, keep, 0)
		byCwd := map[string][]sessionMeta{}
		for _, m := range metas {
			cwd := filepath.Clean(m.Cwd)
			byCwd[cwd] = append(byCwd[cwd], m)
		}
		a.cx.Post(func() { a.setPiSessions(byCwd) })
	}()
}

// setPiSessions puts pi's own sessions under the projects that own them.
func (a *app) setPiSessions(byCwd map[string][]sessionMeta) {
	type update struct {
		ws   *workspace
		list []*session
	}
	var updates []update
	changed := false
	for _, ws := range a.workspaces.GetUntracked() {
		if ws.Target.remote() {
			continue
		}
		metas := byCwd[filepath.Clean(ws.Path)]
		list := make([]*session, 0, len(metas))
		for _, m := range metas {
			list = append(list, a.makeSession(m, ws.Target))
		}
		differs := !ws.piLoaded || ws.PiLoading.GetUntracked() || len(ws.Pi.GetUntracked()) != len(list)
		if differs {
			changed = true
		}
		updates = append(updates, update{ws: ws, list: list})
	}
	if changed {
		a.animateNextLayout()
	}
	for _, u := range updates {
		u.ws.Pi.Set(u.list)
		u.ws.piLoaded = true
		u.ws.PiLoading.Set(false)
	}
}

// reopenSavedTabs puts the tabs a saved config names back on screen; pi's
// own sessions among them are read after the window is up.
func (a *app) reopenSavedTabs() {
	for _, id := range a.cfg.Tabs {
		if a.byID[id] == nil {
			continue
		}
		a.addTab(id)
		if id == a.cfg.LastSession && a.activeID.GetUntracked() == "" {
			a.activeID.Set(id)
		}
		if s := a.byID[id]; s != nil {
			a.scanProject(a.workspaceFor(s.Target, s.WS))
		}
	}
}

// piPath is the pi binary the probe found, "pi" until it runs.
func (a *app) piPath() string {
	if p := a.env.GetUntracked().PiPath; p != "" {
		return p
	}
	return "pi"
}

// piReady reports whether pi answered on this machine.
func (a *app) piReady() bool {
	info := a.env.GetUntracked()
	return info.PiPath != "" && info.PiError == ""
}

// isThemeFile reports whether a name is one the theme loader reads.
func isThemeFile(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".json", ".yaml", ".yml":
		return true
	}
	return false
}

// isJSONFile reports whether a name is a single-file plugin manifest.
func isJSONFile(name string) bool {
	return strings.EqualFold(filepath.Ext(name), ".json")
}

// fileBase is a file's name without its extension.
func fileBase(name string) string {
	return strings.TrimSuffix(filepath.Base(name), filepath.Ext(name))
}

// normalizeAppearance keeps the appearance values the app understands.
func normalizeAppearance(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "light":
		return "light"
	case "dark":
		return "dark"
	case "both":
		return "both"
	}
	return ""
}

// pluginSummary is one line about what a plugin adds.
func pluginSummary(p plugin) string {
	parts := []string{}
	if n := len(p.Commands); n > 0 {
		parts = append(parts, fmt.Sprintf("%d 个命令", n))
	}
	if n := len(p.ThemeSpecs); n > 0 {
		parts = append(parts, fmt.Sprintf("%d 个主题", n))
	}
	if n := len(p.Contributes.Keybindings); n > 0 {
		parts = append(parts, fmt.Sprintf("%d 个键位", n))
	}
	if len(parts) == 0 {
		return "没有可用的命令或主题"
	}
	return strings.Join(parts, " · ")
}
