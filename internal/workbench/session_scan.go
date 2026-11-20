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

// scanProject reads pi's own sessions for one project, the first time it
// is opened. A project shows its own history, not the whole machine's.
func (a *app) scanProject(ws *workspace) {
	if ws == nil || a.st == nil {
		return
	}
	if ws.piLoaded || ws.PiLoading.GetUntracked() {
		return
	}
	if ws.Target.remote() {
		a.scanTargetSessions(ws)
		return
	}
	if !a.cfg.ScanPi {
		return
	}
	ws.PiLoading.Set(true)
	cwd := pathKey(ws.Path)
	projects := []string{ws.Path}
	titles := a.cfg.Titles
	go func() {
		roots := piSessionRoots(projects)
		metas := a.st.scanPiSessionRoots(roots, titles, func(c string) bool { return pathKey(c) == cwd }, 0)
		a.cx.Post(func() {
			ws.piLoaded = true
			list := make([]*session, 0, len(metas))
			for _, m := range metas {
				list = append(list, a.makeSession(m, ws.Target))
			}
			if ws.PiLoading.GetUntracked() || len(ws.Pi.GetUntracked()) != len(list) {
				a.animateNextLayout()
			}
			ws.PiLoading.Set(false)
			ws.Pi.Set(list)
		})
	}()
}

// rescanPi reads pi's own sessions for the projects on screen. It runs
// again when a project is added, so a new folder shows its history at once.
func (a *app) rescanPi() {
	if a.st == nil {
		return
	}
	if !a.cfg.ScanPi {
		for _, ws := range a.workspaces.GetUntracked() {
			ws.Pi.Set(nil)
			ws.PiLoading.Set(false)
		}
		return
	}
	// Projects not read yet pulse while the scan runs, so a count that is
	// still unknown does not read as zero.
	for _, ws := range a.workspaces.GetUntracked() {
		if !ws.Target.remote() && !ws.piLoaded {
			ws.PiLoading.Set(true)
		}
	}
	allowed := map[string]bool{}
	for _, ws := range a.workspaces.GetUntracked() {
		if !ws.Target.remote() {
			allowed[pathKey(ws.Path)] = true
		}
	}
	scanAll := a.cfg.ScanAll
	keep := func(cwd string) bool {
		if scanAll {
			return true
		}
		return allowed[pathKey(cwd)]
	}
	titles := a.cfg.Titles
	projects := a.localProjectPaths()
	// One pass at a time: the newest one answers, so a pass started before
	// a project was added cannot put the old lists back.
	a.piScanGen++
	gen := a.piScanGen
	go func() {
		metas := a.st.scanPiSessionRoots(piSessionRoots(projects), titles, keep, 0)
		byCwd := map[string][]sessionMeta{}
		for _, m := range metas {
			cwd := pathKey(m.Cwd)
			byCwd[cwd] = append(byCwd[cwd], m)
		}
		a.cx.Post(func() {
			if gen != a.piScanGen {
				return // a newer pass already answered
			}
			a.setPiSessions(byCwd)
		})
	}()
}

// setPiSessions puts pi's own sessions under the projects that own them.
func (a *app) setPiSessions(byCwd map[string][]sessionMeta) {
	type update struct {
		ws      *workspace
		list    []*session
		replace bool
	}
	updates := make([]update, 0, len(a.workspaces.GetUntracked()))
	changed := false
	for _, ws := range a.workspaces.GetUntracked() {
		if ws.Target.remote() {
			continue
		}
		metas := byCwd[pathKey(ws.Path)]
		list := make([]*session, 0, len(metas))
		for _, m := range metas {
			list = append(list, a.makeSession(m, ws.Target))
		}
		// A pass that found nothing new leaves the list alone: the rows are
		// the same sessions, and rebuilding them would drop what the rail
		// holds about them (scroll, hover, a menu just opened).
		replace := !ws.piLoaded || !sameSessions(ws.Pi.GetUntracked(), list)
		if replace {
			changed = true
		}
		updates = append(updates, update{ws: ws, list: list, replace: replace})
	}
	if changed {
		a.animateNextLayout()
	}
	for _, u := range updates {
		if u.replace {
			u.ws.Pi.Set(u.list)
		}
		u.ws.piLoaded = true
		u.ws.PiLoading.Set(false)
	}
}

// sameSessions reports whether two readings of a project's pi sessions are
// the same list in the same order. The session objects of an unchanged
// project are reused, so the pointers tell it.
func sameSessions(a, b []*session) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// reopenSavedTabs puts the tabs a saved config names back on screen; pi's
// own sessions among them are read after the window is up.
func (a *app) reopenSavedTabs() {
	for _, id := range a.cfg.Tabs {
		if a.byID[id] == nil {
			continue
		}
		a.addTab(id)
		if id == a.cfg.LastSession && a.activeID.GetUntracked() == "" {
			a.activeID.Set(id)
		}
		if s := a.byID[id]; s != nil {
			a.scanProject(a.workspaceFor(s.Target, s.WS))
		}
	}
}

// piPath is the pi binary the probe found, "pi" until it runs.
func (a *app) piPath() string {
	if p := a.env.GetUntracked().PiPath; p != "" {
		return p
	}
	return "pi"
}

// piReady reports whether pi answered on this machine.
func (a *app) piReady() bool {
	info := a.env.GetUntracked()
	return info.PiPath != "" && info.PiError == ""
}
