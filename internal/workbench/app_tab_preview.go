//go:build !js && !android && !ios

package workbench

import (
	"slices"

	"github.com/nsgo-dev/nsgo/core"
)

const (
	tabOpenPreview = "preview"
	tabOpenFixed   = "fixed"
)

func tabOpenMode(value string) string {
	if value == tabOpenFixed {
		return tabOpenFixed
	}
	return tabOpenPreview
}

func (a *app) isPreviewTab(id string) bool {
	return id != "" && a.previewTab != nil && a.previewTab.Get() == id
}

// openSessionTab keeps existing tabs and replaces only the temporary preview.
func (a *app) openSessionTab(id string) {
	tabs := a.tabs.GetUntracked()
	if slices.Contains(tabs, id) {
		return
	}
	if tabOpenMode(a.cfg.TabOpenMode) == tabOpenFixed || a.byID[id] != nil && a.byID[id].busyNow() {
		a.addTab(id)
		return
	}
	if a.previewTab == nil {
		a.previewTab = core.NewSignal(a.cx, "")
	}
	previous := a.previewTab.GetUntracked()
	if index := slices.Index(tabs, previous); index >= 0 {
		next := slices.Clone(tabs)
		next[index] = id
		a.retireSessionPrewarm(a.byID[previous])
		a.forgetTab(previous)
		a.tabs.Set(next)
	} else {
		a.tabs.Set(append(slices.Clone(tabs), id))
	}
	a.previewTab.Set(id)
}

// fixTab promotes a preview without changing the sidebar's independent pin.
func (a *app) fixTab(id string) {
	if !a.isPreviewTab(id) {
		return
	}
	a.previewTab.Set("")
	a.remember()
}

func (a *app) setTabOpenMode(mode string) {
	mode = tabOpenMode(mode)
	if mode == tabOpenFixed && a.previewTab != nil {
		a.previewTab.Set("")
	}
	a.updateGeneralSettings(func(c *config) { c.TabOpenMode = mode })
	a.remember()
}
