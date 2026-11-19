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
		providers := readProviderStatus(info.PiPath)
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
