//go:build !js && !android && !ios

package main

// The import dialog's actions: scanning the sources, what the list shows,
// what is picked, and the run that converts the picked sessions.

import (
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/nsgo-dev/nsgo/ui"
)

// openImportDialog shows the dialog for the whole machine: a session lands
// in the folder it ran in.
func (a *app) openImportDialog() {
	a.impProject.Set("")
	a.showImportDialog()
}

// openImportDialogFor shows the dialog for one project: everything imported
// from it goes into that project, whatever folder it ran in.
func (a *app) openImportDialogFor(ws *workspace) {
	if ws == nil || ws.Target.remote() {
		a.openImportDialog()
		return
	}
	a.impProject.Set(ws.Path)
	a.showImportDialog()
}

// showImportDialog opens the dialog and scans the sources behind it.
func (a *app) showImportDialog() {
	a.impOpen.Set(true)
	a.impSel.Set(nil)
	a.impQuery.Set("")
	if !a.impScanning.GetUntracked() {
		a.scanImports()
	}
}

// importVisibleRows is the list the dialog shows: one source or all, and
// what the search matches.
func (a *app) importVisibleRows() []importRow {
	only := a.impOnly.GetUntracked()
	query := strings.ToLower(strings.TrimSpace(a.impQuery.GetUntracked()))
	var out []importRow
	for _, row := range a.impRows.GetUntracked() {
		if only != "" && row.Source != only {
			continue
		}
		if query != "" {
			label := ""
			if s := importSourceByKey(row.Source); s != nil {
				label = s.Label
			}
			hay := strings.ToLower(row.Title + " " + row.Cwd + " " + label + " " + row.ID)
			if !strings.Contains(hay, query) {
				continue
			}
		}
		out = append(out, row)
	}
	return out
}

// importRowFor finds a row by its key.
func (a *app) importRowFor(key string) *importRow {
	rows := a.impRows.GetUntracked()
	for i := range rows {
		if rows[i].key() == key {
			return &rows[i]
		}
	}
	return nil
}

// isImportSelected reports whether a row is picked.
func (a *app) isImportSelected(key string) bool {
	for _, k := range a.impSel.GetUntracked() {
		if k == key {
			return true
		}
	}
	return false
}

// toggleImportRow picks or unpicks one row.
func (a *app) toggleImportRow(key string) {
	sel := append([]string(nil), a.impSel.GetUntracked()...)
	for i, k := range sel {
		if k == key {
			a.impSel.Set(append(sel[:i], sel[i+1:]...))
			return
		}
	}
	a.impSel.Set(append(sel, key))
}

// selectImportRows picks every row the list shows that is not up to date,
// or unpicks them all when they were picked already.
func (a *app) selectImportRows() {
	rows := a.importVisibleRows()
	all := true
	for _, row := range rows {
		if row.State != importNew && row.State != importOutdated {
			continue
		}
		if !a.isImportSelected(row.key()) {
			all = false
			break
		}
	}
	if all {
		a.impSel.Set(nil)
		return
	}
	var sel []string
	for _, row := range rows {
		if row.State == importNew || row.State == importOutdated {
			sel = append(sel, row.key())
		}
	}
	a.impSel.Set(sel)
}

// importPicked is how many picked rows a run would convert.
func (a *app) importPicked() []importRow {
	var out []importRow
	for _, row := range a.importVisibleRows() {
		if row.State == importCurrent || !a.isImportSelected(row.key()) {
			continue
		}
		out = append(out, row)
	}
	return out
}

// importPickedElsewhere counts the picks another tab holds, so the footer
// can say the run it is about to start is not all of them.
func (a *app) importPickedElsewhere() int {
	shown := map[string]bool{}
	for _, row := range a.importVisibleRows() {
		shown[row.key()] = true
	}
	n := 0
	for _, row := range a.impRows.GetUntracked() {
		if row.State != importCurrent && !shown[row.key()] && a.isImportSelected(row.key()) {
			n++
		}
	}
	return n
}

// importTargetProject is the project the dialog was opened for.
func (a *app) importTargetProject() *workspace {
	path := strings.TrimSpace(a.impProject.GetUntracked())
	if path == "" {
		return nil
	}
	return a.workspaceFor(localTarget, path)
}

// importChosen converts the picked sessions, a few at a time, and reports
// how it went.
func (a *app) importChosen() {
	if a.impBusy.GetUntracked() {
		return
	}
	rows := a.importPicked()
	if len(rows) == 0 {
		a.toast(ui.ToastInfo, T("还没有选会话"), T("勾上要导入的会话，再点导入。"))
		return
	}
	a.runImport(rows)
}

// importOutcome is how one row's conversion went.
type importOutcome struct {
	key  string
	meta sessionMeta
	err  error
}

// runImport converts rows into the app's store and puts them in the rail.
func (a *app) runImport(rows []importRow) {
	results := make([]importOutcome, len(rows))
	a.impBusy.Set(true)
	a.impDone.Set(0)
	a.impFailed.Set(0)
	a.impTotal.Set(len(rows))

	go func() {
		var mu sync.Mutex
		done, failed := 0, 0
		workers := min(importWorkerLimit, len(rows))
		queue := make(chan int)
		var wg sync.WaitGroup
		for i := 0; i < workers; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := range queue {
					row := rows[i]
					source := importSourceByKey(row.Source)
					var meta sessionMeta
					var err error
					if source == nil {
						err = fmt.Errorf("不认识的来源：%s", row.Source)
					} else {
						cwd := a.importCwdFor(row.importCandidate)
						meta, err = a.convertImport(*source, row.importCandidate, cwd)
					}
					results[i] = importOutcome{key: row.key(), meta: meta, err: err}
					mu.Lock()
					done++
					if err != nil {
						failed++
					}
					progress, failures := done, failed
					mu.Unlock()
					a.cx.Post(func() {
						a.impDone.Set(progress)
						a.impFailed.Set(failures)
					})
				}
			}()
		}
		for i := range rows {
			queue <- i
		}
		close(queue)
		wg.Wait()
		a.cx.Post(func() { a.finishImport(results) })
	}()
}

// finishImport applies a run's results: the rail gains the sessions, the
// list shows where each row stands, and the user hears how it went.
func (a *app) finishImport(results []importOutcome) {
	a.impBusy.Set(false)
	failed := 0
	imported := 0
	firstErr := ""
	rows := append([]importRow(nil), a.impRows.GetUntracked()...)
	for i := range rows {
		for _, r := range results {
			if rows[i].key() != r.key {
				continue
			}
			if r.err != nil {
				rows[i].Err = r.err.Error()
				failed++
				if firstErr == "" {
					firstErr = r.err.Error()
				}
				continue
			}
			rows[i].Err = ""
			rows[i].State = importCurrent
			rows[i].Target = r.meta.File
			imported++
			a.addImportedSession(r.meta)
		}
	}
	a.impRows.Set(rows)
	a.animateNextLayout()
	switch {
	case failed == 0:
		a.toast(ui.ToastSuccess, fmt.Sprintf(T("已导入 %d 个会话"), imported), T("在对应项目的侧栏里，点开就能继续。"))
	case imported == 0:
		a.toast(ui.ToastError, T("导入失败"), firstErr)
	default:
		a.toast(ui.ToastWarning, fmt.Sprintf(T("导入 %d 个，失败 %d 个"), imported, failed), firstErr)
	}
}

// addImportedSession puts an imported session under its project, opening
// the project and bringing the session to the front.
func (a *app) addImportedSession(m sessionMeta) {
	ws := a.workspaceFor(localTarget, m.Cwd)
	if ws == nil {
		a.addWorkspace(m.Cwd)
		ws = a.workspaceFor(localTarget, m.Cwd)
	}
	if ws == nil {
		return
	}
	s := a.makeSession(m, localTarget)
	s.title.Set(m.Title)
	s.updated.Set(m.Updated)
	s.File = m.File
	ws.Expanded.Set(true)
	ws.Sessions.Update(func(ss []*session) []*session {
		out := []*session{s}
		for _, x := range ss {
			if x.ID != s.ID {
				out = append(out, x)
			}
		}
		return out
	})
}

// importSourceCounts is how many rows each source contributes, for the
// dialog's source list.
func (a *app) importSourceCounts() (map[string]int, map[string]int) {
	total := map[string]int{}
	pending := map[string]int{}
	for _, row := range a.impRows.GetUntracked() {
		total[row.Source]++
		if row.State != importCurrent {
			pending[row.Source]++
		}
	}
	return total, pending
}

// importSourcesWithRows lists the sources the dialog found sessions in.
func (a *app) importSourcesWithRows() []*importSource {
	total, _ := a.importSourceCounts()
	var out []*importSource
	for _, s := range importSources {
		if total[s.Key] > 0 {
			out = append(out, s)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return total[out[i].Key] > total[out[j].Key] })
	return out
}
