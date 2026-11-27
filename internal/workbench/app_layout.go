//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"time"

	"github.com/nsgo-dev/nsgo/core"
)

// setLook applies a palette and the side it shows, and keeps both. An
// empty side lets the theme's own side or the system decide.
func (a *app) setLook(theme, side string) {
	a.theme.Set(theme)
	a.cfg.Theme, a.cfg.Appearance = theme, side
	a.applyTheme()
	if a.st != nil {
		a.st.change(func(c *config) { c.Theme, c.Appearance = theme, side })
		a.saveConfigAsync()
	}
	a.emit(eventThemeChanged, appEvent{Data: map[string]string{"theme": theme}})
}

// setTheme lets the settings dialog or a plugin pick the look. A name a
// theme carries resolves to its id, so a plugin can name a theme rather than
// know how the app keys it. Picking a theme clears the side the look button
// pinned, so the theme starts on its own side.
func (a *app) setTheme(name string) {
	if spec := a.themeSpecByName(name); spec != nil {
		name = spec.ID
	}
	a.setLook(name, "")
}

// setTerminalFont changes the terminal's text size and keeps it.
func (a *app) setTerminalFont(size float64) {
	if size < 8 {
		size = 8
	}
	if size > 20 {
		size = 20
	}
	a.termFont.Set(size)
	stored := size
	if size == 12.5 {
		stored = 0
	}
	a.cfg.TerminalFont = stored
	if a.st != nil {
		a.st.change(func(c *config) { c.TerminalFont = stored })
		a.saveConfigAsync()
	}
}

// setEditorFont changes the editor's text size and keeps it.
func (a *app) setEditorFont(size float64) {
	if size < 11 {
		size = 11
	}
	if size > 20 {
		size = 20
	}
	a.editorFont.Set(size)
	stored := int(size + 0.5)
	if stored == 13 {
		stored = 0
	}
	a.cfg.EditorFont = stored
	if a.st != nil {
		a.st.change(func(c *config) { c.EditorFont = stored })
		a.saveConfigAsync()
	}
}

// themeHasSides reports whether the look has its own light and dark
// palettes, so the look button can flip between them. A theme that names one
// side has only that one, and the foundation's looks have none: their sides
// are the 纸白 and 炭黑 ids.
func (a *app) themeHasSides(id string) bool {
	spec := a.themeSpec(id)
	if spec == nil || spec.Appearance == "light" || spec.Appearance == "dark" {
		return false
	}
	return len(spec.Light) > 0 || len(spec.Dark) > 0 || len(spec.LightColors) > 0 || len(spec.DarkColors) > 0
}

// openWorkspaceFolder reveals a folder in the file manager of the machine
// it is on.
func (a *app) openWorkspaceFolder(path string) {
	if path == "" {
		return
	}
	a.openFolder(localTarget, path)
}

// revealProject opens a workspace's folder on its own target.
func (a *app) revealProject(ws *workspace) {
	if ws == nil {
		return
	}
	a.openFolder(ws.Target, ws.Path)
}

// revealSession shows a session where it lives: its file in pi's store, or
// its project's folder for one the app owns.
func (a *app) revealSession(s *session) {
	if s == nil {
		return
	}
	if s.File != "" {
		a.revealFilePath(s.Target, s.File)
		return
	}
	a.revealProject(a.workspaceFor(s.Target, s.WS))
}

// setRailWidth resizes the sidebar and remembers the width once the drag
// rests.
func (a *app) setRailWidth(width core.Points) {
	a.railWidth.Set(width)
	a.railSeq++
	seq := a.railSeq
	a.cx.AfterFunc(300*time.Millisecond, func() {
		if seq != a.railSeq || a.st == nil {
			return
		}
		w := float64(width)
		a.st.edit(func(c *config) { c.RailWidth = w })
	})
}

// setDrawerWidth resizes the right panel and remembers the width.
func (a *app) setDrawerWidth(width core.Points) {
	a.drawerWidth.Set(width)
	a.drawerSeq++
	seq := a.drawerSeq
	a.cx.AfterFunc(300*time.Millisecond, func() {
		if seq != a.drawerSeq || a.st == nil {
			return
		}
		w := float64(width)
		a.st.edit(func(c *config) { c.DrawerWidth = w })
	})
}

// setDrawerTab switches the right panel and remembers which tab it is.
func (a *app) setDrawerTab(name string) {
	if name == "" || a.drawerTab.GetUntracked() == name {
		return
	}
	a.drawerTab.Set(name)
	if a.st != nil {
		a.st.edit(func(c *config) { c.DrawerTab = name })
	}
}

// setImportSel replaces the import dialog's picks and their lookup set.
func (a *app) setImportSel(list []string) {
	set := make(map[string]bool, len(list))
	for _, key := range list {
		set[key] = true
	}
	a.impSelSet = set
	a.impSel.Set(list)
}
