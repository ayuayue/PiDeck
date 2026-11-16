//go:build !js

package main

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
	Projects []*workspace
}

// projectGroups returns the rail's groups in display order.
func (a *app) projectGroups() []projectGroup {
	list := append([]*workspace(nil), a.workspaces.GetUntracked()...)
	a.sortProjects(list)
	var pinned, rest []*workspace
	for _, w := range list {
		if w.Pinned {
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
		name := firstNonEmpty(strings.TrimSpace(w.Group), "未分组")
		if i, ok := index[name]; ok {
			groups[i].Projects = append(groups[i].Projects, w)
			continue
		}
		index[name] = len(groups)
		groups = append(groups, projectGroup{Name: name, Projects: []*workspace{w}})
	}
	return groups
}

// sortProjects orders the list by the configured sort.
func (a *app) sortProjects(list []*workspace) {
	switch a.cfg.ProjectSort {
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

// setProjectSort changes how the rail orders projects.
func (a *app) setProjectSort(sort string) {
	a.cfg.ProjectSort = sort
	if a.st != nil {
		a.st.edit(func(c *config) { c.ProjectSort = sort })
	}
	a.projectsRev.Update(func(n int) int { return n + 1 })
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

// cycleProjectSort moves to the next project order.
func (a *app) cycleProjectSort() {
	switch a.cfg.ProjectSort {
	case "":
		a.setProjectSort("recent")
	case "recent":
		a.setProjectSort("created")
	case "created":
		a.setProjectSort("title")
	default:
		a.setProjectSort("")
	}
}

// projectSortLabel names the current project order.
func projectSortLabel(a *app) string {
	switch a.cfg.ProjectSort {
	case "recent":
		return "项目排序：最近活动"
	case "created":
		return "项目排序：创建时间"
	case "title":
		return "项目排序：名称"
	}
	return "项目排序：手动"
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
