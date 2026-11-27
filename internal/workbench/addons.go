//go:build !js && !android && !ios

package workbench

// Looks and add-ons. A theme is a set of palette roles and design tokens
// over the app's own; a plugin is a folder of JSON that adds commands and
// themes. They do not run plugin code; commands still invoke approved host
// actions. Both are read again without restarting.
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

import "slices"

type addonFiles struct {
	plugins []plugin
	themes  []themeSpec
	archive pluginArchiveSnapshot
}

func (a *app) readAddonFiles(disabled []string) addonFiles {
	plugins := a.loadPlugins(disabled)
	archived, err := a.archivedPlugins()
	return addonFiles{plugins, a.loadThemes(plugins), pluginArchiveSnapshot{archived, err}}
}

func (a *app) publishAddonFiles(files addonFiles) {
	a.plugins.Set(files.plugins)
	a.themes.Set(files.themes)
	a.pluginArchive.Set(files.archive)
	a.applyTheme()
	a.applyKeybindings()
	if done := a.pluginFilesReloaded; done != nil {
		a.pluginFilesReloaded = nil
		done()
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
	executable := a.cfg.PiExecutable
	disabled := slices.Clone(a.cfg.DisabledPlugins)
	a.addonsGen++
	gen := a.addonsGen
	go func() {
		// This machine first: it is what opening a session needs.
		info := probeLocalWithExecutable(envInfo{AppDir: dataDir, Probing: true, TargetsProbing: true}, executable)
		addons := a.readAddonFiles(disabled)
		localInfo := info
		a.cx.Post(func() {
			if executable == a.cfg.PiExecutable {
				a.env.Set(localInfo)
			}
			if gen != a.addonsGen {
				return // a newer reload already answered
			}
			a.publishAddonFiles(addons)
			a.loadProviders(a.piPath())
			a.reopenSavedTabs()
			a.rescanPi()
		})
		// Other machines take longer; they fill in when they answer.
		info = probeTargets(info)
		a.cx.Post(func() {
			// A slow remote probe must not replace a newer local selection.
			next := a.env.GetUntracked()
			next.WSL, next.SSH, next.TargetsProbing = info.WSL, info.SSH, info.TargetsProbing
			a.env.Set(next)
		})
	}()
}

// reloadAddons reads plugins and themes again without probing machines
// or sessions: what the settings page needs after a file changes.
func (a *app) reloadAddons() {
	if a.st == nil {
		return
	}
	disabled := slices.Clone(a.cfg.DisabledPlugins)
	a.addonsGen++
	gen := a.addonsGen
	go func() {
		addons := a.readAddonFiles(disabled)
		a.cx.Post(func() {
			if gen != a.addonsGen {
				return // a newer reload already answered
			}
			a.publishAddonFiles(addons)
		})
	}()
}

// setPluginEnabled remembers whether a plugin runs and reloads add-ons.
func (a *app) setPluginEnabled(id string, enabled bool) {
	if a.st == nil {
		return
	}
	a.st.change(func(c *config) {
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
	a.savePluginConfig()
	a.reloadAddons()
}
