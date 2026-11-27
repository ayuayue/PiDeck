//go:build !js && !android && !ios

package workbench

import (
	"github.com/nsgo-dev/nsgo/core"
	"strings"
)

func selectionSet(signal *core.Signal[map[string]bool], key string, on bool) {
	next := map[string]bool{}
	for k, v := range signal.GetUntracked() {
		if v {
			next[k] = true
		}
	}
	if on {
		next[key] = true
	} else {
		delete(next, key)
	}
	signal.Set(next)
}

func (a *app) modelHidden(provider, id string) bool {
	key := provider + "/" + id
	for _, v := range a.cfg.HiddenModels {
		if v == key {
			return true
		}
	}
	return false
}
func (a *app) toggleModelHidden(provider, id string) {
	key := provider + "/" + id
	hidden := a.modelHidden(provider, id)
	out := make([]string, 0, len(a.cfg.HiddenModels)+1)
	for _, v := range a.cfg.HiddenModels {
		if v != key {
			out = append(out, v)
		}
	}
	if !hidden {
		out = append(out, key)
	}
	a.cfg.HiddenModels = out
	if a.st != nil {
		a.st.edit(func(c *config) { c.HiddenModels = append([]string(nil), out...) })
	}
	a.bumpSettings()
}

// Preferences refer to identities, so rename/delete must update their owner too.
// An empty oldModel addresses the entire provider; an empty newProvider removes it.
func (a *app) migrateProviderPreferences(oldProvider, oldModel, newProvider, newModel string) {
	remap := func(key string) string {
		prefix := oldProvider + "/"
		if !strings.HasPrefix(key, prefix) || (oldModel != "" && key != prefix+oldModel) {
			return key
		}
		if newProvider == "" {
			return ""
		}
		id := strings.TrimPrefix(key, prefix)
		if oldModel != "" {
			id = newModel
		}
		return newProvider + "/" + id
	}
	list := func(in []string) []string {
		out := []string{}
		seen := map[string]bool{}
		for _, v := range in {
			if k := remap(v); k != "" && !seen[k] {
				out = append(out, k)
				seen[k] = true
			}
		}
		return out
	}
	choice := func(c modelChoice) modelChoice {
		if c.Provider != oldProvider || (oldModel != "" && c.ID != oldModel) {
			return c
		}
		if newProvider == "" {
			return modelChoice{}
		}
		c.Provider = newProvider
		if oldModel != "" {
			c.ID = newModel
		}
		return c
	}
	fav := list(a.favModels.GetUntracked())
	a.favModels.Set(fav)
	a.cfg.FavModels = fav
	a.cfg.HiddenModels = list(a.cfg.HiddenModels)
	a.defaultModel = choice(a.defaultModel)
	a.cfg.Model = a.defaultModel
	for k, v := range a.cfg.ToolModels {
		if v.Provider == oldProvider && (oldModel == "" || v.Model == oldModel) {
			if newProvider == "" {
				delete(a.cfg.ToolModels, k)
			} else {
				v.Provider = newProvider
				if oldModel != "" {
					v.Model = newModel
				}
				a.cfg.ToolModels[k] = v
			}
		}
	}
	if oldModel == "" {
		out := []string{}
		for _, id := range a.cfg.ProviderOrder {
			if id == oldProvider {
				id = newProvider
			}
			if id != "" {
				out = append(out, id)
			}
		}
		a.cfg.ProviderOrder = out
	}
	if a.cfg.ImageProvider == oldProvider && (oldModel == "" || a.cfg.ImageModel == oldModel) {
		a.cfg.ImageProvider = newProvider
		if oldModel != "" {
			a.cfg.ImageModel = newModel
		}
		if newProvider == "" {
			a.cfg.ImageModel = ""
		}
	}
	if a.cfg.VisionProvider == oldProvider && (oldModel == "" || a.cfg.VisionModel == oldModel) {
		a.cfg.VisionProvider = newProvider
		if oldModel != "" {
			a.cfg.VisionModel = newModel
		}
		if newProvider == "" {
			a.cfg.VisionModel = ""
		}
	}
	if a.st != nil {
		a.st.edit(func(c *config) {
			c.FavModels = append([]string(nil), fav...)
			c.HiddenModels = append([]string(nil), a.cfg.HiddenModels...)
			c.Model = a.cfg.Model
			c.ProviderOrder = append([]string(nil), a.cfg.ProviderOrder...)
			c.ToolModels = map[string]toolModelCfg{}
			for k, v := range a.cfg.ToolModels {
				c.ToolModels[k] = v
			}
			c.ImageProvider = a.cfg.ImageProvider
			c.ImageModel = a.cfg.ImageModel
			c.VisionProvider = a.cfg.VisionProvider
			c.VisionModel = a.cfg.VisionModel
		})
	}
	a.toolRev.Update(func(n int) int { return n + 1 })
	a.bumpSettings()
}
