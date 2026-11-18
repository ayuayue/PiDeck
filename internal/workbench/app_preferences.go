//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"sort"

	"github.com/nsgo-dev/nsgo/core"
)

// settingsTick subscribes the caller to settings changes; pages call it so a
// switch redraws with the value it now holds.
func (a *app) settingsTick() {
	if a.settingsRev != nil {
		a.settingsRev.Get()
	}
}

// bumpSettings redraws the settings page after a value changed, and puts
// the reader back where they were: the redraw makes a new scroll view.
func (a *app) bumpSettings() {
	if a.settingsRev == nil {
		return
	}
	a.settingsRev.Update(func(n int) int { return n + 1 })
	a.restoreSettingsScroll()
}

// settingsScrolled remembers the settings page's offset.
func (a *app) settingsScrolled(e core.ScrollEvent) {
	if e.Offset.Y >= 0 {
		a.settingsOffset = e.Offset
	}
}

// restoreSettingsScroll scrolls a redrawn page back to where it was.
func (a *app) restoreSettingsScroll() {
	if a.settingsOffset.Y <= 0 || a.settingsScroll == nil {
		return
	}
	at := a.settingsOffset
	a.cx.Post(func() {
		a.settingsScroll.ScrollTo(at, false)
		a.cx.Post(func() { a.settingsScroll.ScrollTo(at, false) })
	})
}

// setSessionSort changes how a project orders its sessions.
func (a *app) setSessionSort(sort string) {
	if sort != "name" {
		sort = "updated"
	}
	a.cfg.SessionSort = sort
	if a.st != nil {
		a.st.edit(func(c *config) { c.SessionSort = sort })
	}
	a.projectsRev.Update(func(n int) int { return n + 1 })
	a.bumpSettings()
}

// togglePin keeps a session at the top, or lets it go.
func (a *app) togglePin(s *session) {
	if s == nil {
		return
	}
	ids := a.pinned.GetUntracked()
	if a.isPinned(s.ID) {
		out := ids[:0]
		for _, id := range ids {
			if id != s.ID {
				out = append(out, id)
			}
		}
		a.pinned.Set(out)
	} else {
		a.pinned.Set(append(append([]string(nil), ids...), s.ID))
	}
	a.st.edit(func(c *config) { c.Pinned = append([]string(nil), a.pinned.GetUntracked()...) })
}

// toggleFavModel stars a model, or unstars it.
func (a *app) toggleFavModel(m modelInfo) {
	if m.ID == "" {
		return
	}
	key := m.Provider + "/" + m.ID
	list := a.favModels.GetUntracked()
	out := make([]string, 0, len(list)+1)
	found := false
	for _, k := range list {
		if k == key {
			found = true
			continue
		}
		out = append(out, k)
	}
	if !found {
		out = append(out, key)
	}
	a.favModels.Set(out)
	a.st.edit(func(c *config) { c.FavModels = append([]string(nil), out...) })
}

// providerOrder is the provider list in the user's order, with any the
// config does not name appended alphabetically.
func (a *app) providerOrder() []string {
	var out []string
	seen := map[string]bool{}
	for _, p := range a.cfg.ProviderOrder {
		if !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	var rest []string
	for _, p := range a.providers.GetUntracked() {
		if !seen[p.ID] {
			rest = append(rest, p.ID)
		}
	}
	sort.Strings(rest)
	return append(out, rest...)
}

// moveProvider moves a provider up or down in the order.
func (a *app) moveProvider(id string, delta int) {
	order := a.providerOrder()
	ix := -1
	for i, p := range order {
		if p == id {
			ix = i
			break
		}
	}
	if ix < 0 {
		return
	}
	j := ix + delta
	if j < 0 || j >= len(order) {
		return
	}
	order[ix], order[j] = order[j], order[ix]
	a.cfg.ProviderOrder = order
	a.st.edit(func(c *config) { c.ProviderOrder = append([]string(nil), order...) })
}

// pinProvider puts a provider first in the order.
func (a *app) pinProvider(id string) {
	order := a.providerOrder()
	out := []string{id}
	for _, p := range order {
		if p != id {
			out = append(out, p)
		}
	}
	a.cfg.ProviderOrder = out
	a.st.edit(func(c *config) { c.ProviderOrder = append([]string(nil), out...) })
}

// moveFavourite moves a starred model up or down among the favourites.
func (a *app) moveFavourite(key string, delta int) {
	list := append([]string(nil), a.favModels.GetUntracked()...)
	ix := -1
	for i, k := range list {
		if k == key {
			ix = i
			break
		}
	}
	if ix < 0 {
		return
	}
	j := ix + delta
	if j < 0 || j >= len(list) {
		return
	}
	list[ix], list[j] = list[j], list[ix]
	a.favModels.Set(list)
	a.st.edit(func(c *config) { c.FavModels = append([]string(nil), list...) })
}

// isFavModel reports whether a model is starred.
func (a *app) isFavModel(m modelInfo) bool {
	key := m.Provider + "/" + m.ID
	for _, k := range a.favModels.Get() {
		if k == key {
			return true
		}
	}
	return false
}
