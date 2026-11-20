//go:build !js && !android && !ios

package workbench

// Config and session storage. The app keeps its own JSON config beside a
// private pi session directory, so browsing history never touches the
// sessions a terminal pi or PiDeck may have open.

import (
	"encoding/json"
	"os"
)

// save writes the config as it is now.
func (s *store) save() error {
	s.mu.Lock()
	raw, err := json.MarshalIndent(s.c, "", "  ")
	path := s.path
	s.mu.Unlock()
	if err != nil {
		return err
	}
	return writeFileAtomic(path, raw, 0o644)
}

// reload rereads config.json after something outside the store wrote it,
// such as a settings backup.
func (s *store) reload() error {
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return err
	}
	var c config
	if err := json.Unmarshal(raw, &c); err != nil {
		return err
	}
	if c.Titles == nil {
		c.Titles = map[string]string{}
	}
	migrateConfig(&c, raw)
	s.mu.Lock()
	s.c = &c
	s.mu.Unlock()
	return nil
}

// config returns a copy safe to read on the UI thread.
func (s *store) config() config {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := *s.c
	c.Workspaces = append([]workspaceCfg(nil), s.c.Workspaces...)
	c.Tabs = append([]string(nil), s.c.Tabs...)
	c.Pinned = append([]string(nil), s.c.Pinned...)
	c.FavModels = append([]string(nil), s.c.FavModels...)
	c.ProviderOrder = append([]string(nil), s.c.ProviderOrder...)
	c.DisabledPlugins = append([]string(nil), s.c.DisabledPlugins...)
	c.Keybindings = make(map[string]string, len(s.c.Keybindings))
	for k, v := range s.c.Keybindings {
		c.Keybindings[k] = v
	}
	c.Titles = make(map[string]string, len(s.c.Titles))
	for k, v := range s.c.Titles {
		c.Titles[k] = v
	}
	c.TrustedProjects = append([]string(nil), s.c.TrustedProjects...)
	c.RecentFiles = append([]string(nil), s.c.RecentFiles...)
	c.Archived = append([]string(nil), s.c.Archived...)
	c.ToolModels = make(map[string]toolModelCfg, len(s.c.ToolModels))
	for k, v := range s.c.ToolModels {
		c.ToolModels[k] = v
	}
	if s.c.BackgroundOpacity != nil {
		v := *s.c.BackgroundOpacity
		c.BackgroundOpacity = &v
	}
	if s.c.SoundVolume != nil {
		v := *s.c.SoundVolume
		c.SoundVolume = &v
	}
	c.PluginSettings = make(map[string]string, len(s.c.PluginSettings))
	for k, v := range s.c.PluginSettings {
		c.PluginSettings[k] = v
	}
	c.SessionPersonas = make(map[string]string, len(s.c.SessionPersonas))
	for k, v := range s.c.SessionPersonas {
		c.SessionPersonas[k] = v
	}
	c.RecentCommands = append([]string(nil), s.c.RecentCommands...)
	c.RecentSearches = append([]string(nil), s.c.RecentSearches...)
	c.ForkParents = make(map[string]string, len(s.c.ForkParents))
	for k, v := range s.c.ForkParents {
		c.ForkParents[k] = v
	}
	c.Balances = make(map[string]balanceSpec, len(s.c.Balances))
	for k, v := range s.c.Balances {
		c.Balances[k] = v
	}
	return c
}

// edit changes the config and writes it.
func (s *store) edit(fn func(*config)) {
	s.mu.Lock()
	fn(s.c)
	s.mu.Unlock()
	_ = s.save()
}
