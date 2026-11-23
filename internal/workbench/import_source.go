//go:build !js && !android && !ios

package workbench

// Importing sessions from other agents. A source is one tool whose history
// this app can read (Claude Code, Codex, Cursor, Kimi, …): it lists the
// sessions in its store and turns one into a pi session in this app's own
// store, so an imported session is browsable and resumable like any other.
//
// What is written is a normal pi session file, plus a marker line right
// after the header that names the source session and the version of the
// file it came from. The marker is what makes a second import a no-op, and
// a changed source (`outdated`) a re-import instead of a duplicate.

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"example.com/pideck-v2/internal/sessionimport"
	"example.com/pideck-v2/internal/viewkit"
)

// importScanWorkers bounds concurrent source scans; each scan reads headers.
const importScanWorkers = 8

// importTarget is where a source session goes for a project folder.
func (s *store) importTarget(source sessionimport.Source, c sessionimport.Candidate, cwd string) string {
	return filepath.Join(s.sessions, encodeCwd(filepath.Clean(cwd)), sessionimport.FileName(source, c.ID))
}

// importIndex maps "source|id" to the file already imported for it.
func (s *store) importIndex() map[string]string {
	index := map[string]string{}
	_ = filepath.WalkDir(s.sessions, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(strings.ToLower(d.Name()), ".jsonl") {
			return nil
		}
		base := strings.TrimSuffix(d.Name(), filepath.Ext(d.Name()))
		src, id, ok := strings.Cut(base, "_")
		if !ok || sessionimport.SourceByKey(src) == nil {
			return nil
		}
		index[src+"|"+id] = path
		return nil
	})
	return index
}

// scanImports lists every source's sessions, in parallel, and reports them
// as they come. A source that cannot be read is left out rather than
// failing the whole list.
func (a *app) scanImports() {
	if a.st == nil {
		return
	}
	a.impScanning.Set(true)
	a.impGen++
	gen := a.impGen
	index := a.st.importIndex()
	go func() {
		var mu sync.Mutex
		var rows []sessionimport.Row
		var wg sync.WaitGroup
		sem := make(chan struct{}, importScanWorkers)
		for _, source := range sessionimport.Sources {
			source := source
			wg.Add(1)
			go func() {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				found, _ := sessionimport.Scan(*source, index)
				mu.Lock()
				rows = append(rows, found...)
				mu.Unlock()
			}()
		}
		wg.Wait()
		sort.SliceStable(rows, func(i, j int) bool { return rows[i].Updated.After(rows[j].Updated) })
		a.cx.Post(func() {
			if gen != a.impGen {
				return
			}
			a.impScanning.Set(false)
			a.impRows.Set(rows)
			// A remembered tab whose store now holds nothing falls back to
			// the list of everything.
			if only := a.impOnly.GetUntracked(); only != "" {
				found := false
				for _, row := range rows {
					if row.Source == only {
						found = true
						break
					}
				}
				if !found {
					a.impOnly.Set("")
				}
			}
			a.animateNextLayout()
		})
	}()
}

// convertImport writes one source session into the app's store as a pi
// session for cwd, replacing the copy it imported before when there is one.
func (a *app) convertImport(source sessionimport.Source, c sessionimport.Candidate, cwd string) (sessionMeta, error) {
	if a.st == nil {
		return sessionMeta{}, fmt.Errorf("还没有打开数据目录")
	}
	parsed, err := source.Read(c.Path)
	if err != nil {
		return sessionMeta{}, err
	}
	if len(parsed.Messages) == 0 {
		return sessionMeta{}, fmt.Errorf("这个会话没有可导入的消息")
	}
	title := firstNonEmpty(parsed.Title, c.Title, viewkit.FirstLine(sessionimport.FirstUserText(parsed.Messages), 60), c.ID)
	updated := c.Updated
	if updated.IsZero() {
		updated = parsed.Updated
	}
	if updated.IsZero() {
		updated = time.Now()
	}
	if strings.TrimSpace(cwd) == "" {
		cwd = parsed.Cwd
	}
	if strings.TrimSpace(cwd) == "" {
		cwd = "."
	}
	cwd = filepath.Clean(cwd)
	return a.st.writeImported(source, c, parsed, cwd, sessionimport.DisplayTitle(source, title), updated)
}

// writeImported writes the parsed session as a pi session file, atomically:
// a half-written import never shows up in the rail.
func (s *store) writeImported(source sessionimport.Source, c sessionimport.Candidate, parsed sessionimport.Session, cwd, title string, updated time.Time) (sessionMeta, error) {
	dir := filepath.Join(s.sessions, encodeCwd(cwd))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return sessionMeta{}, err
	}
	target := filepath.Join(dir, sessionimport.FileName(source, c.ID))
	id := ""
	if head, ok := sessionimport.ReadSessionHead(target); ok {
		id = head.ID
	}
	if id == "" {
		id = newSessionID()
	}
	tmp := target + ".importing"
	f, err := os.Create(tmp)
	if err != nil {
		return sessionMeta{}, err
	}
	err = sessionimport.WritePiSession(f, id, cwd, title, updated, parsed, source, c)
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		_ = os.Chtimes(tmp, updated, updated)
		err = os.Rename(tmp, target)
	}
	if err != nil {
		_ = os.Remove(tmp)
		return sessionMeta{}, err
	}
	m, ok := s.readMeta(target, nil)
	if !ok {
		return sessionMeta{}, fmt.Errorf("导入后无法读取该会话")
	}
	return m, nil
}

// importCwdFor is the folder an imported session is written for: the
// project the dialog was opened for when it names one, else the folder it
// ran in when that still exists, else the project the user is looking at.
func (a *app) importCwdFor(c sessionimport.Candidate) string {
	if target := strings.TrimSpace(a.impProject.GetUntracked()); target != "" {
		return filepath.Clean(target)
	}
	if c.Cwd != "" {
		if info, err := os.Stat(c.Cwd); err == nil && info.IsDir() {
			return filepath.Clean(c.Cwd)
		}
		if runtime.GOOS == "windows" {
			// The recorded case may differ from the folder's own.
			if ws := a.workspaceFor(localTarget, c.Cwd); ws != nil {
				return ws.Path
			}
		}
	}
	if ws := a.activeWorkspace(); ws != nil && !ws.Target.remote() {
		return ws.Path
	}
	return ""
}
