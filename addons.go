package main

// Looks and add-ons. A theme is a set of palette roles over the app's own
// palette; a plugin is a folder of JSON that adds palette commands and
// themes. Neither runs code, so a broken add-on can only be dull, not
// dangerous, and both are read again without restarting.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/oneo-me/nsgo/core"
)

// themeSpec is one look: the built-in ones, or a file of roles over them.
type themeSpec struct {
	ID      string
	Name    string
	Builtin bool
	// Light and Dark map palette role names (background, surface, text,
	// accent, inset…) to CSS colors.
	Light map[string]string
	Dark  map[string]string
}

// themeFile is a theme's JSON: a name and the roles it sets.
type themeFile struct {
	Name  string            `json:"name"`
	Light map[string]string `json:"light"`
	Dark  map[string]string `json:"dark"`
}

// swatch is the color a theme is shown by in the picker.
func (t themeSpec) swatch() core.Color {
	roles := t.Light
	if t.ID == "dark" {
		roles = t.Dark
	}
	for _, name := range []string{"accent", "background", "surface"} {
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

// plugin is a folder of add-ons.
type plugin struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Prompts     []pluginPrompt `json:"prompts"`
	Themes      []themeFile    `json:"themes"`
	Path        string         `json:"-"`
	Error       string         `json:"-"`
}

// pluginPrompt is a palette command a plugin adds: a title and what it
// puts in the composer.
type pluginPrompt struct {
	Title  string `json:"title"`
	Prompt string `json:"prompt"`
	Group  string `json:"group"`
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
	add := func(name string, f themeFile) {
		id := "user:" + name
		if seen[id] || strings.TrimSpace(name) == "" {
			return
		}
		seen[id] = true
		specs = append(specs, themeSpec{ID: id, Name: name, Light: f.Light, Dark: f.Dark})
	}
	if dir := a.themesDir(); dir != "" {
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".json") {
				continue
			}
			raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
			if err != nil {
				continue
			}
			var f themeFile
			if json.Unmarshal(raw, &f) != nil {
				continue
			}
			name := f.Name
			if name == "" {
				name = strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))
			}
			add(name, f)
		}
	}
	for _, p := range plugins {
		for i, f := range p.Themes {
			name := f.Name
			if name == "" {
				name = p.Name + " " + string(rune('A'+i))
			}
			add(name, f)
		}
	}
	return specs
}

// loadPlugins reads every plugin JSON under the plugins folder: a file, or
// a folder with plugin.json.
func (a *app) loadPlugins() []plugin {
	dir := a.pluginsDir()
	if dir == "" {
		return nil
	}
	var out []plugin
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		path := filepath.Join(dir, e.Name())
		if e.IsDir() {
			path = filepath.Join(path, "plugin.json")
		} else if !strings.HasSuffix(strings.ToLower(e.Name()), ".json") {
			continue
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var p plugin
		if err := json.Unmarshal(raw, &p); err != nil {
			out = append(out, plugin{Name: e.Name(), Path: path, Error: err.Error()})
			continue
		}
		p.Path = path
		if p.Name == "" {
			p.Name = strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))
		}
		if p.ID == "" {
			p.ID = p.Name
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
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
  "light": {"background": "#f7f9fc", "inset": "#eef2f8", "border": "rgba(15, 23, 42, 0.12)"},
  "dark":  {"background": "#0f1419", "inset": "#151d24", "accent": "#7aa2f7"}
}
`), 0o644)
		}
	}
	if dir := a.pluginsDir(); dir != "" {
		_ = os.MkdirAll(dir, 0o755)
		example := filepath.Join(dir, "example-plugin.json")
		if _, err := os.Stat(example); os.IsNotExist(err) {
			_ = os.WriteFile(example, []byte(`{
  "name": "示例插件",
  "description": "在这里放几条常做的提示词，命令面板里就能直接选用。",
  "prompts": [
    {"title": "梳理当前改动", "prompt": "看看工作区里未提交的改动，用要点说明它们做了什么、有没有风险。", "group": "示例插件"}
  ]
}
`), 0o644)
		}
	}
}

// applyTheme gives the window its look: the appearance, then the palette
// over the app's own.
func (a *app) applyTheme() {
	name := a.theme.GetUntracked()
	switch name {
	case "light":
		a.cx.SetAppearance(core.AppearanceLight)
	case "dark":
		a.cx.SetAppearance(core.AppearanceDark)
	default:
		a.cx.SetAppearance(core.AppearanceSystem)
	}
	base := pideckTheme()
	if spec := a.themeSpec(name); spec != nil {
		applyRoles(&base.Light, spec.Light)
		applyRoles(&base.Dark, spec.Dark)
	}
	a.cx.SetTheme(base)
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
	go func() {
		// This machine first: it is what opening a session needs.
		info := probeLocal(envInfo{AppDir: dataDir, Probing: true, TargetsProbing: true})
		plugins := a.loadPlugins()
		themes := a.loadThemes(plugins)
		providers := probeProviders(info.PiPath, readProviders())
		a.cx.Post(func() {
			a.env.Set(info)
			a.plugins.Set(plugins)
			a.themes.Set(themes)
			a.providers.Set(providers)
			a.applyTheme()
			a.reopenSavedTabs()
			a.rescanPi()
		})
		// Other machines take longer; they fill in when they answer.
		info = probeTargets(info)
		a.cx.Post(func() { a.env.Set(info) })
	}()
}

// scanProject reads pi's own sessions for one project, the first time it
// is opened. A project shows its own history, not the whole machine's.
func (a *app) scanProject(ws *workspace) {
	if ws == nil || a.st == nil || ws.Target.remote() || !a.cfg.ScanPi {
		return
	}
	if ws.piLoaded || ws.piLoading {
		return
	}
	root := a.env.GetUntracked().SessionsDir
	if root == "" {
		root = piSessionsDir()
	}
	if root == "" {
		return
	}
	ws.piLoading = true
	cwd := filepath.Clean(ws.Path)
	titles := a.cfg.Titles
	limit := 60
	go func() {
		metas := a.st.scanPiSessions(root, titles, func(c string) bool { return filepath.Clean(c) == cwd }, limit)
		a.cx.Post(func() {
			ws.piLoading = false
			ws.piLoaded = true
			list := make([]*session, 0, len(metas))
			for _, m := range metas {
				list = append(list, a.makeSession(m, ws.Target))
			}
			if len(metas) >= limit {
				ws.PiMore = 1
			}
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
		}
		return
	}
	info := a.env.GetUntracked()
	if info.SessionsDir == "" {
		info.SessionsDir = piSessionsDir()
	}
	if info.SessionsDir == "" {
		return
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
	for _, ws := range a.workspaces.GetUntracked() {
		if ws.Target.remote() {
			continue
		}
		metas := byCwd[filepath.Clean(ws.Path)]
		const limit = 30
		list := make([]*session, 0, min(len(metas), limit))
		for i, m := range metas {
			if i >= limit {
				ws.PiMore = len(metas) - limit
				break
			}
			list = append(list, a.makeSession(m, ws.Target))
		}
		ws.Pi.Set(list)
		ws.piLoaded = true
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
