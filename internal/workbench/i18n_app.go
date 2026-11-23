//go:build !js && !android && !ios

package workbench

// The interface language follows a setting only the workbench stores.

import (
	"os"
	"strings"

	"example.com/pideck-v2/internal/apptext"
)

// applyLanguage sets the interface language from the config and the
// system, and asks the pages that hold static text to rebuild.
func (a *app) applyLanguage() {
	setting := a.cfg.Language
	if setting == "" {
		setting = strings.TrimSpace(os.Getenv("PIDECK_V2_LANG"))
	}
	apptext.SetLanguage(apptext.ResolveLanguage(setting, a.cx.Env().Locale()))
	if a.langRev != nil {
		a.langRev.Update(func(n int) int { return n + 1 })
	}
}

// setLanguage remembers the user's choice and applies it.
func (a *app) setLanguage(code string) {
	a.cfg.Language = code
	if a.st != nil {
		a.st.edit(func(c *config) { c.Language = code })
	}
	a.applyLanguage()
	a.bumpSettings()
}
