//go:build !js && !android && !ios

package workbench

// The interface language follows a setting only the workbench stores.

import (
	"os"
	"strings"

	"example.com/pideck/internal/apptext"
)

// applyLanguage sets the interface language from the config and the
// system, and asks the pages that hold static text to rebuild.
func (a *app) applyLanguage() {
	setting := a.cfg.Language
	if setting == "" {
		setting = strings.TrimSpace(os.Getenv("PIDECK_V2_LANG"))
	}
	// Force the choice before reading the locale back: a scope that follows
	// the system reports it again only once nothing is forced.
	a.cx.SetLocale(apptext.Locale(setting))
	apptext.SetLanguage(apptext.ResolveLanguage(setting, a.cx.Env().Locale()))
	if a.langRev != nil {
		a.langRev.Update(func(n int) int { return n + 1 })
	}
}

// setLanguage remembers the user's choice and applies it.
func (a *app) setLanguage(code string) {
	a.cfg.Language = code
	if a.st != nil {
		a.st.change(func(c *config) { c.Language = code })
		a.saveConfigAsync()
	}
	a.applyLanguage()
	a.bumpSettings()
}
