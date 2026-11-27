//go:build !js && !android && !ios

package workbench

// The rail's project groups: pinned projects first, then the groups the
// user named, each ordered by the chosen sort.

import (
	"sort"
	"strings"
	"time"
)

// projectGroup is a named run of projects.
type projectGroup struct {
	Name     string
	Named    bool
	Projects []*workspace
}

// projectGroupDirectory is a draft choice, not a workspace until saved.
type projectGroupDirectory struct {
	target target
	path   string
	label  string
}

func (d projectGroupDirectory) key() string {
	path := d.path
	if !d.target.remote() {
		path = pathKey(path)
	}
	return d.target.key() + "|" + path
}

// projectGroups returns the rail's groups in display order. The built-in
// chat is not a project: it has the rail's chat column.
func (a *app) projectGroups() []projectGroup {
	var list []*workspace
	for _, w := range a.workspaces.GetUntracked() {
		if w != nil && !w.Chat {
			list = append(list, w)
		}
	}
	a.sortProjects(list)
	var pinned, rest []*workspace
	for _, w := range list {
		if w.Pinned && strings.TrimSpace(w.Group) == "" {
			pinned = append(pinned, w)
		} else {
			rest = append(rest, w)
		}
	}
	var groups []projectGroup
	if len(pinned) > 0 {
		groups = append(groups, projectGroup{Name: "置顶", Projects: pinned})
	}
	index := map[string]int{}
	for _, w := range rest {
		group := strings.TrimSpace(w.Group)
		if i, ok := index[group]; ok {
			groups[i].Projects = append(groups[i].Projects, w)
			continue
		}
		index[group] = len(groups)
		groups = append(groups, projectGroup{Name: firstNonEmpty(group, "未分组"), Named: group != "", Projects: []*workspace{w}})
	}
	return groups
}

// sortProjects orders the list by the configured sort.
func (a *app) sortProjects(list []*workspace) {
	switch a.projectSortMode() {
	case "recent":
		sort.SliceStable(list, func(i, j int) bool {
			ti, tj := workspaceActivity(list[i]), workspaceActivity(list[j])
			if !ti.Equal(tj) {
				return ti.After(tj)
			}
			return strings.ToLower(list[i].label()) < strings.ToLower(list[j].label())
		})
	case "created":
		sort.SliceStable(list, func(i, j int) bool {
			ti, tj := list[i].Added, list[j].Added
			if ti.IsZero() != tj.IsZero() {
				return !ti.IsZero()
			}
			if !ti.Equal(tj) {
				return ti.After(tj)
			}
			return strings.ToLower(list[i].label()) < strings.ToLower(list[j].label())
		})
	case "title":
		sort.SliceStable(list, func(i, j int) bool {
			return strings.ToLower(list[i].label()) < strings.ToLower(list[j].label())
		})
	}
}

// projectSortMode is the effective order, with recent activity as the
// default for configs written before a project order was chosen.
func (a *app) projectSortMode() string {
	switch a.cfg.ProjectSort {
	case "manual", "created", "title":
		return a.cfg.ProjectSort
	default:
		return "recent"
	}
}

// workspaceActivity is the newest change among a project's sessions.
func workspaceActivity(w *workspace) time.Time {
	var latest time.Time
	for _, s := range w.Sessions.GetUntracked() {
		if t := s.updated.GetUntracked(); t.After(latest) {
			latest = t
		}
	}
	for _, s := range w.Pi.GetUntracked() {
		if t := s.updated.GetUntracked(); t.After(latest) {
			latest = t
		}
	}
	return latest
}

// saveProjects writes the rail's projects back to the config.
func (a *app) saveProjects() {
	if a.st == nil {
		return
	}
	list := a.workspaces.GetUntracked()
	a.st.edit(func(c *config) {
		out := make([]workspaceCfg, 0, len(list))
		for _, w := range list {
			out = append(out, workspaceCfg{Path: w.Path, Name: w.Name, Target: w.Target.key(),
				Expanded: w.Expanded.GetUntracked(), Group: w.Group, Pinned: w.Pinned, Added: w.Added,
				ACPPreset: w.ACPPreset, Chat: w.Chat})
		}
		c.Workspaces = out
	})
	a.projectsRev.Update(func(n int) int { return n + 1 })
	a.bumpSettings()
}

// toggleProjectPin keeps a project at the top of the rail.
func (a *app) toggleProjectPin(w *workspace) {
	if w == nil {
		return
	}
	w.Pinned = !w.Pinned
	a.saveProjects()
}

// moveProject moves a project one place in the stored order.
func (a *app) moveProject(w *workspace, delta int) {
	if w == nil {
		return
	}
	list := a.workspaces.GetUntracked()
	idx := -1
	for i, x := range list {
		if x == w {
			idx = i
			break
		}
	}
	j := idx + delta
	if idx < 0 || j < 0 || j >= len(list) {
		return
	}
	// A move is only visible in manual order. Switch first so the stored
	// list the move changes is also the list on screen.
	a.setProjectSort("manual")
	list[idx], list[j] = list[j], list[idx]
	a.workspaces.Set(list)
	a.saveProjects()
}

// setProjectGroup puts a project in a named group, "" for ungrouped.
func (a *app) setProjectGroup(w *workspace, group string) {
	if w == nil {
		return
	}
	w.Group = strings.TrimSpace(group)
	a.saveProjects()
}

// createProjectGroup reuses each directory's workspace, keeping sessions and
// per-project state in place. A cancelled draft never calls this method.
func (a *app) createProjectGroup(name string, directories []projectGroupDirectory) {
	name = strings.TrimSpace(name)
	if name == "" {
		return
	}
	a.cx.Batch(func() {
		changed := false
		for _, dir := range directories {
			path := cleanTargetPath(dir.target, dir.path)
			if path == "" {
				continue
			}
			ws := a.workspaceFor(dir.target, path)
			if ws == nil {
				a.addWorkspaceFor(dir.target, path, "")
				ws = a.workspaceFor(dir.target, path)
			}
			if ws != nil && !ws.Chat {
				ws.Group = name
				changed = true
			}
		}
		if changed {
			a.saveProjects()
		}
	})
}

// dissolveProjectGroup restores the member projects without removing folders,
// sessions, pinning, custom names, or their original order.
func (a *app) dissolveProjectGroup(name string) {
	name = strings.TrimSpace(name)
	if name == "" {
		return
	}
	changed := false
	for _, ws := range a.workspaces.GetUntracked() {
		if ws != nil && !ws.Chat && strings.TrimSpace(ws.Group) == name {
			ws.Group = ""
			changed = true
		}
	}
	if changed {
		a.saveProjects()
	}
}

// setProjectSort changes how the rail orders projects.
func (a *app) setProjectSort(sort string) {
	a.cfg.ProjectSort = sort
	if a.st != nil {
		a.st.edit(func(c *config) { c.ProjectSort = sort })
	}
	a.projectsRev.Update(func(n int) int { return n + 1 })
	a.bumpSettings()
}

// askProjectGroup opens the group dialog for a project.
func (a *app) askProjectGroup(w *workspace) {
	if w == nil {
		return
	}
	a.projectGroupPath.Set(w.Path)
	a.projectGroupText.Set(w.Group)
	a.projectGroupOpen.Set(true)
}

// saveProjectGroup applies the dialog's group.
func (a *app) saveProjectGroup() {
	path := a.projectGroupPath.GetUntracked()
	for _, w := range a.workspaces.GetUntracked() {
		if w.Path == path {
			a.setProjectGroup(w, a.projectGroupText.GetUntracked())
			break
		}
	}
	a.projectGroupOpen.Set(false)
}

// pinProjectLabel names the pin action for a project's state.
func pinProjectLabel(w *workspace) string {
	if w != nil && w.Pinned {
		return "取消置顶"
	}
	return "置顶项目"
}

// projectGroupNames lists the groups already in use.
func (a *app) projectGroupNames() []string {
	seen := map[string]bool{}
	var out []string
	for _, w := range a.workspaces.GetUntracked() {
		g := strings.TrimSpace(w.Group)
		if g == "" || seen[g] {
			continue
		}
		seen[g] = true
		out = append(out, g)
	}
	sort.Strings(out)
	return out
}
