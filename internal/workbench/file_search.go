//go:build !js && !android && !ios

package workbench

// Searching inside the workspace's files.

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/ui"
)

// fileHit is one match: the file (relative, slash separated), the line and
// column of the match, and the line's text.
type fileHit struct {
	File string
	Line int
	Col  int
	Text string
}

const (
	fileSearchMaxHits  = 200
	fileSearchPerFile  = 5
	fileSearchMaxBytes = 2 << 20
	fileSearchTextMax  = 200
)

// searchWorkspace finds a query in the given files, ignoring case, at most
// a few matches per file and fileSearchMaxHits in all. Large and binary
// files are skipped.
func searchWorkspace(root string, files []string, query string) []fileHit {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" || root == "" {
		return nil
	}
	var hits []fileHit
	for _, rel := range files {
		if len(hits) >= fileSearchMaxHits {
			break
		}
		path := filepath.Join(root, filepath.FromSlash(rel))
		info, err := os.Stat(path)
		if err != nil || info.IsDir() || info.Size() > fileSearchMaxBytes {
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil || bytes.IndexByte(data[:min(len(data), 8000)], 0) >= 0 {
			continue
		}
		inFile := 0
		for i, line := range strings.Split(string(data), "\n") {
			lower := strings.ToLower(line)
			at := strings.Index(lower, q)
			if at < 0 {
				continue
			}
			hits = append(hits, fileHit{File: rel, Line: i + 1, Col: utf8.RuneCountInString(line[:at]) + 1,
				Text: hitText(line, fileSearchTextMax)})
			inFile++
			if inFile >= fileSearchPerFile || len(hits) >= fileSearchMaxHits {
				break
			}
		}
	}
	return hits
}

// hitText trims a line for a result row.
func hitText(line string, max int) string {
	s := strings.TrimSpace(strings.TrimRight(line, "\r"))
	if utf8.RuneCountInString(s) > max {
		s = string([]rune(s)[:max]) + "…"
	}
	return s
}

// openFileSearch shows the content search, or says why it cannot.
func (a *app) openFileSearch() {
	if a.quickOpenRoot() == "" {
		a.toast(ui.ToastInfo, apptext.T("先打开一个工作区"), apptext.T("快速打开会在项目里找文件。"))
		return
	}
	a.fileSearchOpen.Set(true)
}

// runFileSearch scans and searches off the UI thread, dropping results from
// a replaced query or a workspace that is no longer active.
func (a *app) runFileSearch() {
	root := a.quickOpenRoot()
	query := strings.TrimSpace(a.fileSearchQuery.GetUntracked())
	if root == "" || query == "" {
		a.fileSearchSeq++
		a.fileSearchBusy.Set(false)
		a.setFileSearch(root, nil)
		return
	}
	files := a.workspaceFiles(root)
	a.fileSearchSeq++
	seq := a.fileSearchSeq
	a.fileSearchBusy.Set(true)
	a.setFileSearch(root, nil)
	go func() {
		if len(files) == 0 {
			files = walkWorkspaceFiles(root)
		}
		hits := searchWorkspace(root, files, query)
		a.cx.Post(func() {
			if seq != a.fileSearchSeq {
				return
			}
			a.fileSearchBusy.Set(false)
			if root != a.quickOpenRoot() {
				return
			}
			a.setFileSearch(root, hits)
		})
	}()
}

// setFileSearch replaces the hits and their owning workspace, then redraws.
func (a *app) setFileSearch(root string, hits []fileHit) {
	a.fileSearchMu.Lock()
	a.fileSearchRoot = root
	a.fileSearchHits = hits
	a.fileSearchMu.Unlock()
	a.fileSearchRev.Update(func(n int) int { return n + 1 })
}

// fileSearchResults copies only the current workspace's hits for the UI.
func (a *app) fileSearchResults() []fileHit {
	root := a.quickOpenRoot()
	a.fileSearchMu.Lock()
	defer a.fileSearchMu.Unlock()
	if root != a.fileSearchRoot {
		return nil
	}
	return append([]fileHit(nil), a.fileSearchHits...)
}
