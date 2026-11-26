//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"slices"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// remember writes what reopens next time.
func (a *app) remember() {
	if a.st == nil {
		return
	}
	tabs := slices.Concat(a.tabs.GetUntracked(), a.pendingTabs)
	last := a.activeID.GetUntracked()
	if a.pendingActive != "" {
		last = a.pendingActive
	}
	open := a.sidebar.GetUntracked()
	drawer := a.drawer.GetUntracked()
	theme := a.theme.GetUntracked()
	model, thinking := a.defaultModel, a.defaultThinking
	termOpen := a.term.open.GetUntracked()
	termHeight := a.term.height.GetUntracked()
	a.st.edit(func(c *config) {
		c.Tabs = append([]string(nil), tabs...)
		c.LastSession = last
		c.SidebarOpen = open
		c.DrawerOpen = drawer
		c.Theme = theme
		c.Model = model
		c.Thinking = thinking
		c.TerminalOpen = termOpen
		c.TerminalHeight = termHeight
	})
}

// selectSession brings a session to the front, opening its tab.
func (a *app) selectSession(s *session) {
	if s == nil {
		return
	}
	if previous := a.active(); previous != nil && previous != s {
		a.retireSessionPrewarm(previous)
	}
	a.pendingActive = ""
	if a.editor != nil {
		a.editor.open.Set(false)
	}
	a.activePane.Set("")
	a.activeID.Set(s.ID)
	if ws := a.workspaceFor(s.Target, s.WS); ws != nil {
		a.activeWS.Set(projectWireKey(ws))
		if !ws.Expanded.GetUntracked() {
			ws.Expanded.Set(true)
		}
	} else {
		a.activeWS.Set("")
	}
	a.addTab(s.ID)
	a.revealTab(s.ID)
	a.openSessionHistory(s)
	if a.drawer.GetUntracked() && a.drawerTab.GetUntracked() == "git" {
		a.git.attach(a.workspaceFor(s.Target, s.WS))
	}
	a.remember()
	a.emit(eventSessionOpened, appEvent{Session: s})
}

// openWorkspaceKey opens the project a palette row names: it expands the
// folder and shows its newest session.
func (a *app) openWorkspaceKey(key string) {
	for _, ws := range a.workspaces.GetUntracked() {
		if ws.Target.key()+"|"+ws.Path != key {
			continue
		}
		ws.Expanded.Set(true)
		a.activeWS.Set(projectWireKey(ws))
		if list := ws.Sessions.GetUntracked(); len(list) > 0 {
			a.selectSession(list[0])
		}
		return
	}
}

// addTab appends a tab once.
func (a *app) addTab(id string) {
	found := false
	for _, t := range a.tabs.GetUntracked() {
		if t == id {
			found = true
			break
		}
	}
	if !found {
		a.tabs.Update(func(ts []string) []string { return append(ts, id) })
	}
}

// tabRef is one tab's element, made on first use.
func (a *app) tabRef(key string) *core.Ref {
	if a.tabRefs == nil {
		a.tabRefs = map[string]*core.Ref{}
	}
	ref := a.tabRefs[key]
	if ref == nil {
		ref = new(core.Ref)
		a.tabRefs[key] = ref
	}
	return ref
}

// revealTab scrolls the tab bar until a tab shows. The tab is revealed
// after the commit that mounted it, so a tab made in the same turn (a new
// session, a pane opening) lands in sight in the bar above the content.
func (a *app) revealTab(key string) {
	a.cx.Post(func() {
		selected := a.activeID.GetUntracked()
		if pane := a.activePaneID(); pane != "" {
			selected = paneTabKey(pane)
		}
		if selected != key {
			return
		}
		if ref := a.tabRefs[key]; ref != nil {
			ref.Reveal(core.RevealOptions{Horizontal: core.ScrollAlignNearest, Animated: !a.navigationReduced(a.cx),
				Margin: core.Edges{Left: 6, Right: 6}})
		}
	})
}

// forgetTab drops a closed tab's element.
func (a *app) forgetTab(key string) { delete(a.tabRefs, key) }

// closeTab closes a tab, keeping the session and its engine running.
func (a *app) closeTab(id string) {
	tabs := a.tabs.GetUntracked()
	ix := -1
	for i, t := range tabs {
		if t == id {
			ix = i
			break
		}
	}
	if ix < 0 {
		return
	}
	next := append(append([]string(nil), tabs[:ix]...), tabs[ix+1:]...)
	a.retireSessionPrewarm(a.byID[id])
	a.tabs.Set(next)
	a.forgetTab(id)
	if a.byID[id] != nil {
		a.closedTabs = append(a.closedTabs, id)
		if len(a.closedTabs) > 10 {
			a.closedTabs = a.closedTabs[len(a.closedTabs)-10:]
		}
	}
	if a.activeID.GetUntracked() == id {
		if len(next) > 0 {
			n := next[min(ix, len(next)-1)]
			if s := a.byID[n]; s != nil {
				a.selectSession(s)
			}
		} else {
			a.activeID.Set("")
			a.activeWS.Set("")
		}
	}
	a.remember()
}

// reopenTab brings back the last closed session's tab.
func (a *app) reopenTab() {
	for len(a.closedTabs) > 0 {
		id := a.closedTabs[len(a.closedTabs)-1]
		a.closedTabs = a.closedTabs[:len(a.closedTabs)-1]
		s := a.byID[id]
		if s == nil {
			continue
		}
		for _, t := range a.tabs.GetUntracked() {
			if t == id {
				a.selectSession(s)
				return
			}
		}
		a.addTab(id)
		a.selectSession(s)
		return
	}
	a.toast(ui.ToastInfo, "没有可恢复的标签", "关掉的会话标签会记在这里。")
}

// closeOtherTabs closes every tab but one.
func (a *app) closeOtherTabs(id string) {
	for _, t := range append([]string(nil), a.tabs.GetUntracked()...) {
		if t != id {
			a.closeTab(t)
		}
	}
}

// closeTabsRight closes the tabs after one.
func (a *app) closeTabsRight(id string) {
	tabs := append([]string(nil), a.tabs.GetUntracked()...)
	ix := -1
	for i, t := range tabs {
		if t == id {
			ix = i
			break
		}
	}
	if ix < 0 {
		return
	}
	for _, t := range tabs[ix+1:] {
		a.closeTab(t)
	}
}

// closeAllTabs closes every open tab.
func (a *app) closeAllTabs() {
	for _, t := range append([]string(nil), a.tabs.GetUntracked()...) {
		a.closeTab(t)
	}
}

// cycleTab moves between tabs like a browser.
func (a *app) cycleTab(delta int) {
	tabs := a.tabs.GetUntracked()
	if len(tabs) < 2 {
		return
	}
	ix := 0
	for i, id := range tabs {
		if id == a.activeID.GetUntracked() {
			ix = i
		}
	}
	ix = (ix + delta + len(tabs)) % len(tabs)
	if s := a.byID[tabs[ix]]; s != nil {
		a.selectSession(s)
	}
}
