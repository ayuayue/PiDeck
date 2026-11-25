//go:build !js && !android && !ios

package workbench

// The Git drawer's changes: the staged files, then the working tree's.
// The list is capped and can be read as a folder tree or as a flat list,
// so a repository with many changed files still leaves room for the commit
// box and the history.

import (
	"fmt"
	"sort"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// gitChanges is the changed files, grouped by index and worktree.
func (a *app) gitChanges(cx *core.Scope) core.Node {
	return core.View{Style: core.Style{Gap: 3}, Children: []core.Node{
		a.gitChangesBar(cx),
		core.Dynamic(func(cx *core.Scope) core.Node { return a.gitChangesBody(cx) }),
	}}
}

// gitChangesBar is the section's heading and the actions for the whole
// list: how it reads, and staging, unstaging or dropping everything.
func (a *app) gitChangesBar(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	busy := func() bool { return a.git.busy.Get() != "" }
	total := func() int { return len(a.git.state.Get().Files) }
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, MinHeight: core.Pt(24)}, Children: []core.Node{
		gitSectionTitle(colors, apptext.T("更改")),
		gitCount(colors, func() string { return fmt.Sprint(total()) }),
		core.View{Style: core.Style{FlexGrow: 1}},
		core.Dynamic(func(cx *core.Scope) core.Node {
			if a.git.view.Get() == gitViewTree {
				return hint("按列表显示", a.pressIcon(lucide.List, apptext.T("按列表显示"), 22, 12.5, nil,
					func() { a.setGitChangesView(gitViewFlat) }, "git-view-toggle"))
			}
			return hint("按目录树显示", a.pressIcon(lucide.FolderTree, apptext.T("按目录树显示"), 22, 12.5, nil,
				func() { a.setGitChangesView(gitViewTree) }, "git-view-toggle"))
		}),
		hint("暂存全部", a.pressIcon(lucide.Plus, apptext.T("暂存全部"), 22, 12.5,
			func() bool { return busy() || a.git.state.Get().changedCount() == 0 }, a.gitStageAll, "git-stage-all")),
		hint("取消暂存全部", a.pressIcon(lucide.Minus, apptext.T("取消暂存全部"), 22, 12.5,
			func() bool { return busy() || a.git.state.Get().stagedCount() == 0 }, a.gitUnstageAll, "git-unstage-all")),
		hint("丢弃全部改动", a.pressIcon(lucide.Undo2, apptext.T("丢弃全部改动"), 22, 12.5,
			func() bool { return busy() || total() == 0 }, a.gitDiscardAll, "git-discard-all")),
	}}
}

// gitChangesBody is the rows: the conflicts, the staged group and the
// worktree's, cut to the row budget.
func (a *app) gitChangesBody(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	st := a.git.state.Get()
	tree := a.git.view.Get() == gitViewTree
	collapsed := a.git.collapsed.Get()
	budget := a.git.filesShown.Get()
	var staged, worktree []gitFile
	for _, f := range st.Files {
		if f.staged() {
			staged = append(staged, f)
		}
		if f.unstaged() {
			worktree = append(worktree, f)
		}
	}
	var rows []core.Node
	if conflicts := st.conflicts(); len(conflicts) > 0 {
		rows = append(rows, a.gitConflictsRow(cx, len(conflicts)))
	}
	hidden := 0
	// group draws one group: its heading, when the section's own heading does
	// not already say it, then at most cap file rows. The folders above them
	// come along, and are folded when there are too many of them.
	group := func(title string, files []gitFile, isStaged bool, heading bool, cap int) {
		if heading {
			rows = append(rows, core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5,
				MinHeight: core.Pt(22), Margin: core.Edges{Top: 4}}, Children: []core.Node{
				core.Text{Content: title, Style: core.Style{FontSize: 11.5, FontWeight: ui.Medium}, StyleFunc: ui.Colored(colors.Muted)},
				gitCount(colors, func() string { return fmt.Sprint(len(files)) }),
			}})
		}
		list, drawn := a.gitFileRows(cx, files, tree, collapsed, isStaged, cap)
		hidden += len(files) - drawn
		rows = append(rows, list...)
	}
	if len(st.Files) == 0 {
		rows = append(rows, core.Text{Content: apptext.T("工作区干净"), Style: core.Style{FontSize: 11.5, Padding: core.Symmetric(4, 6)},
			StyleFunc: ui.Colored(colors.Faint)})
	} else {
		// When both groups have files, neither takes the whole budget:
		// a group left without rows looks empty, and hides work the user
		// still has to do.
		stagedCap := budget
		worktreeCap := budget
		if len(staged) > 0 && len(worktree) > 0 {
			stagedCap = min(len(staged), max(2, budget/2))
			worktreeCap = max(2, budget-stagedCap)
		}
		// An empty group is a heading and an apology, so only the groups
		// with files are listed: an empty index leaves the section's own
		// heading saying 更改 over the worktree's rows.
		if len(staged) > 0 {
			group(apptext.T("已暂存"), staged, true, true, stagedCap)
		}
		if len(worktree) > 0 {
			group(apptext.T("更改"), worktree, false, len(staged) > 0, worktreeCap)
		}
	}
	if hidden > 0 {
		n := hidden
		rows = append(rows, a.gitListTail(apptext.T("还有 %d 个文件未显示", n), "git-files-more", a.showAllGitFiles))
	} else if a.git.filesShown.GetUntracked() > gitFilesShown && len(st.Files) > gitFilesShown {
		rows = append(rows, a.gitListTail(apptext.T("收起"), "git-files-fold", a.collapseGitFiles))
	}
	return core.View{Style: core.Style{Gap: 0}, Children: rows}
}

// gitConflictsRow is the way into the files a merge left with marks.
func (a *app) gitConflictsRow(cx *core.Scope, count int) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{
		OnPress: func(core.PressEvent) { a.gitConflictsOpen.Set(true) },
		Role:    core.RoleButton, Label: apptext.T("%d 个文件有冲突", count), TestID: "git-conflicts",
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, MinHeight: core.Pt(30),
				Padding: core.Symmetric(0, 8), CornerRadius: 7, Background: ui.Alpha(colors.Danger(), 0.10),
				BorderWidth: 1, BorderColor: ui.Alpha(colors.Danger(), 0.28), Transition: viewkit.PressMotion,
				Hover: &core.Style{Background: ui.Alpha(colors.Danger(), 0.16)}}
		},
		Children: []core.Node{
			ui.Icon(lucide.TriangleAlert, 12, colors.Danger),
			core.Text{Content: apptext.T("%d 个文件有冲突", count), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FontSize: 12, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Danger)},
			ui.Text(apptext.T("解决…"), 11, ui.Medium, colors.Danger),
		}}
}

// gitListTail is the quiet button under a list: show the rest, or fold it
// back to its first page.
func (a *app) gitListTail(label, testID string, press func()) core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{OnPress: func(core.PressEvent) { press() },
		Role: core.RoleButton, Label: label, TestID: testID,
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
				Height: core.Pt(26), CornerRadius: 6, Hover: &core.Style{Background: colors.Hover()}}
		},
		Children: []core.Node{core.Text{Content: label, MaxLines: 1, Style: core.Style{FontSize: 11.5}, StyleFunc: ui.Colored(colors.Muted)}}}
}

// gitFileRows draws a group within the row budget: the flat list of paths,
// or the tree of their folders with the folded ones left closed. Folders
// use the budget too, and a folder left without a visible file is dropped
// rather than shown empty. The second result is how many files it drew,
// so the caller can count what is left over.
func (a *app) gitFileRows(cx *core.Scope, files []gitFile, tree bool, collapsed map[string]bool, staged bool, budget int) ([]core.Node, int) {
	if budget <= 0 {
		return nil, 0
	}
	if !tree {
		list := files
		if len(list) > budget {
			list = list[:budget]
		}
		rows := make([]core.Node, 0, len(list))
		for _, f := range list {
			rows = append(rows, a.gitFileRow(cx, f, staged, 0, true))
		}
		return rows, len(rows)
	}
	entries := gitChangeTree(files, collapsed)
	// The tree spends rows on folders as well, so a file budget is what
	// bounds it, with the folders that hold those files coming along. A
	// folder whose files all fall outside the budget is left out rather
	// than shown empty.
	kept := make([]gitChangeEntry, 0, budget)
	var paths []string
	rowCap := budget + 2
	for _, e := range entries {
		if len(kept) >= rowCap {
			break
		}
		if e.Dir {
			kept = append(kept, e)
			continue
		}
		if len(paths) >= budget {
			break
		}
		paths = append(paths, e.Path)
		kept = append(kept, e)
	}
	rows := make([]core.Node, 0, len(kept))
	drawn := 0
	for _, e := range kept {
		if e.Dir {
			if !gitFolderReaches(e.Path, paths) {
				continue
			}
			rows = append(rows, a.gitDirRow(cx, e))
			continue
		}
		drawn++
		rows = append(rows, a.gitFileRow(cx, e.File, staged, e.Depth, false))
	}
	return rows, drawn
}

// gitFolderReaches reports whether a folder holds one of the files drawn.
func gitFolderReaches(folder string, paths []string) bool {
	prefix := folder + "/"
	for _, p := range paths {
		if strings.HasPrefix(p, prefix) {
			return true
		}
	}
	return false
}

// gitChangeEntry is one row of the changes tree.
type gitChangeEntry struct {
	Path  string // the folder or file, from the repository root
	Name  string
	Dir   bool
	Depth int
	Count int // files under a folder
	File  gitFile
}

// gitChangeTree folds the changed paths into folders. A folded folder is a
// row of its own and hides what it holds.
func gitChangeTree(files []gitFile, collapsed map[string]bool) []gitChangeEntry {
	root := newGitChangeDir("", "")
	for _, f := range files {
		parts := strings.Split(strings.Trim(f.Path, "/"), "/")
		at := root
		for i, segment := range parts {
			if i == len(parts)-1 {
				at.files = append(at.files, gitChangeEntry{Path: f.Path, Name: segment, File: f})
				break
			}
			child, ok := at.dirs[segment]
			if !ok {
				child = newGitChangeDir(segment, strings.Join(parts[:i+1], "/"))
				at.dirs[segment] = child
			}
			at = child
		}
	}
	var out []gitChangeEntry
	var walk func(d *gitChangeDir, depth int)
	walk = func(d *gitChangeDir, depth int) {
		names := make([]string, 0, len(d.dirs))
		for name := range d.dirs {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			child := d.dirs[name]
			// Fold a chain of one-child folders into one row: "src/app" is
			// easier to scan than a row per level, and saves the room the
			// rows would take.
			label, path := child.name, child.path
			for len(child.files) == 0 && len(child.dirs) == 1 {
				next := child.onlyDir()
				label, path = label+"/"+next.name, next.path
				child = next
			}
			out = append(out, gitChangeEntry{Path: path, Name: label, Dir: true, Depth: depth, Count: child.count()})
			if !collapsed[path] {
				walk(child, depth+1)
			}
		}
		sorted := append([]gitChangeEntry(nil), d.files...)
		sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })
		for _, e := range sorted {
			e.Depth = depth
			out = append(out, e)
		}
	}
	walk(root, 0)
	return out
}

// gitChangeDir is one folder while the tree is built.
type gitChangeDir struct {
	name  string
	path  string
	dirs  map[string]*gitChangeDir
	files []gitChangeEntry
}

func newGitChangeDir(name, path string) *gitChangeDir {
	return &gitChangeDir{name: name, path: path, dirs: map[string]*gitChangeDir{}}
}

// count is how many changed files a folder holds.
func (d *gitChangeDir) count() int {
	n := len(d.files)
	for _, child := range d.dirs {
		n += child.count()
	}
	return n
}

// onlyDir is the sole subfolder of a folder with no files of its own.
func (d *gitChangeDir) onlyDir() *gitChangeDir {
	for _, child := range d.dirs {
		return child
	}
	return nil
}

// gitDirRow is one folder of the tree; a press folds or opens it.
func (a *app) gitDirRow(cx *core.Scope, e gitChangeEntry) core.Node {
	colors := ui.ColorsOf(cx)
	folded := a.git.collapsed.Get()[e.Path]
	return core.View{
		OnPress: func(core.PressEvent) { a.toggleGitFolder(e.Path) },
		Role:    core.RoleButton, Label: e.Path, TestID: "git-dir",
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, MinHeight: core.Pt(30),
				Padding: core.Edges{Left: core.Points(4 + e.Depth*12), Right: 4}, CornerRadius: 6, Transition: viewkit.PressMotion,
				Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{
			ui.IconOf(func() *core.SVG {
				if folded {
					return lucide.ChevronRight()
				}
				return lucide.ChevronDown()
			}, 11, colors.Faint),
			ui.IconOf(func() *core.SVG {
				if folded {
					return lucide.Folder()
				}
				return lucide.FolderOpen()
			}, 13, colors.Muted),
			core.Text{Content: e.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
			gitCount(colors, func() string { return fmt.Sprint(e.Count) }),
		},
	}
}

// gitFileRow is one changed path and its actions.
func (a *app) gitFileRow(cx *core.Scope, f gitFile, staged bool, depth int, showPath bool) core.Node {
	colors := ui.ColorsOf(cx)
	tone := gitTone(f, colors)
	name, dir := viewkit.SplitGitPath(f.Path)
	// The name is what the user scans; the folder it sits in follows it in
	// the flat list and truncates first when the drawer is narrow.
	label := name
	action := func(icon func() *core.SVG, label string, press func(), testID string) core.Node {
		return a.pressIcon(icon, label, 21, 11.5, func() bool { return a.git.busy.Get() != "" }, press, testID)
	}
	var actions []core.Node
	switch {
	case f.Conflicted:
		// A conflicted path has no "theirs" or "ours" to discard; the
		// dialog offers the three ways out.
		actions = append(actions, action(lucide.GitMerge, "解决冲突 "+name,
			func() { a.gitConflictsOpen.Set(true) }, "git-resolve"))
	case staged:
		actions = append(actions, action(lucide.Minus, "取消暂存 "+name, func() { a.gitUnstageFile(f) }, "git-unstage"))
	default:
		actions = append(actions, action(lucide.Plus, "暂存 "+name, func() { a.gitStageFile(f) }, "git-stage"))
	}
	if !f.Conflicted {
		actions = append(actions, action(lucide.Undo2, "丢弃 "+name, func() { a.gitDiscardFile(f) }, "git-discard"))
	}
	testID := "git-file"
	if staged {
		testID = "git-staged-file"
	}
	row := core.View{
		OnPress: func(core.PressEvent) { a.gitShowFileDiff(f, staged) },
		Role:    core.RoleButton, Label: f.Path, TestID: testID,
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinHeight: core.Pt(30),
				Padding: core.Edges{Left: core.Points(4 + depth*12), Right: 2}, CornerRadius: 6, Transition: viewkit.PressMotion,
				Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{
			core.View{Style: core.Style{Width: core.Pt(16), Height: core.Pt(16), CornerRadius: 4, AlignItems: core.AlignCenter,
				JustifyContent: core.JustifyCenter, Background: ui.Alpha(tone, 0.13), FlexShrink: 0},
				Children: []core.Node{ui.Text(f.mark(), 9.5, ui.Semibold, func() core.Color { return tone })}},
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5},
				Children: []core.Node{
					core.Text{Content: label, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style: core.Style{FontSize: 12.5, FlexShrink: 1, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Text)},
					core.Show{When: func() bool { return showPath && dir != "" }, Then: func(cx *core.Scope) core.Node {
						return core.Text{Content: dir, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style:     core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10, FlexShrink: 3, MinWidth: core.Pt(0)},
							StyleFunc: ui.Colored(colors.Faint)}
					}},
				}},
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 0, FlexShrink: 0}, Children: actions},
		},
	}
	return base.ContextMenu{
		Trigger: row,
		Children: []core.Node{
			a.menuRow(a.cx, lucide.FileDiff, apptext.T("查看差异"), "", false, func() { a.gitShowFileDiff(f, staged) }),
			a.menuRow(a.cx, lucide.Clock, apptext.T("文件历史"), f.Path, false, func() { a.openFileHistory(f.Path) }),
			a.menuRow(a.cx, lucide.GitBranch, apptext.T("追溯"), "", false, func() { a.openBlame(f.Path) }),
			a.menuRow(a.cx, lucide.Undo2, apptext.T("丢弃更改"), "", true, func() { a.gitDiscardFile(f) }),
		},
		PopupStyle:     core.Style{MinWidth: core.Pt(180)},
		PopupStyleFunc: func() core.Style { return a.menuCard(a.cx) },
	}
}
