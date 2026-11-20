//go:build !js && !android && !ios

package workbench

import (
	"context"
	"strings"
	"time"

	"github.com/nsgo-dev/nsgo/ui"
)

const searchDebounce = 250 * time.Millisecond
const searchVisibleLimit = 60

// A result belongs to one run. Rows keep its identity so a late press
// cannot open a session from a query that has already been replaced.
type searchResult struct {
	query string
	hits  []searchHit
}

func (a *app) loadSearchIndex() {
	if a.searchIndexed || a.searchBusy.GetUntracked() {
		return
	}
	a.searchBusy.Set(true)
	var roots []string
	if a.st != nil {
		roots = append(roots, a.st.sessions)
	}
	projects, archiveDir := a.localProjectPaths(), a.acpArchiveDir()
	go func() {
		roots = uniqueSessionRoots(append(roots, piSessionRoots(projects)...)...)
		docs := buildSearchIndex(roots, archiveDir)
		a.cx.Post(func() {
			// Once published, the slice is read-only. An active query can
			// finish scanning it while a later rebuild prepares its own slice.
			a.searchDocs = docs
			a.searchIndexed = true
			a.searchBusy.Set(false)
			a.runSearch()
		})
	}()
}

func (a *app) openSearch() {
	a.invalidateSearch()
	a.searchText.Set("")
	a.searchOpen.Set(true)
	a.loadSearchIndex()
}

func (a *app) closeSearch() {
	a.searchOpen.Set(false)
	a.invalidateSearch()
	if a.searchText.GetUntracked() != "" {
		a.searchText.Set("")
	}
}

func (a *app) rebuildSearch() {
	a.invalidateSearch()
	a.searchIndexed = false
	a.loadSearchIndex()
}

func (a *app) stopSearchTimer() {
	if a.searchTimer != nil {
		a.searchTimer()
		a.searchTimer = nil
	}
}

func (a *app) invalidateSearch() {
	a.stopSearchTimer()
	if a.searchCancel != nil {
		a.searchCancel()
		a.searchCancel = nil
	}
	a.searchEnter = false
	a.searchResults.Set(nil)
}

func (a *app) setSearchQuery(value string) {
	if value == a.searchText.GetUntracked() {
		return
	}
	a.invalidateSearch()
	a.searchText.Set(value)
	if strings.TrimSpace(value) != "" {
		a.searchTimer = a.cx.AfterFunc(searchDebounce, a.runSearch)
	}
}

// runSearch moves matching off the UI thread. Enter bypasses the debounce
// but still waits for the result of the current query.
func (a *app) runSearch() {
	a.stopSearchTimer()
	query := strings.TrimSpace(a.searchText.GetUntracked())
	if !a.searchOpen.GetUntracked() || query == "" || a.searchResults.GetUntracked() != nil || a.searchCancel != nil {
		return
	}
	if !a.searchIndexed {
		a.loadSearchIndex()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.searchCancel = cancel
	docs := a.searchDocs
	go func() {
		result := &searchResult{query: query, hits: matchSearch(ctx, docs, query, 0)}
		a.cx.Post(func() {
			if ctx.Err() != nil || !a.searchOpen.GetUntracked() || strings.TrimSpace(a.searchText.GetUntracked()) != query {
				return
			}
			cancel()
			a.searchCancel = nil
			a.searchResults.Set(result)
			if a.searchEnter {
				a.searchEnter = false
				a.openSearchTop()
			}
		})
	}()
}

func (a *app) openSearchTop() {
	if result := a.searchResults.GetUntracked(); result != nil {
		for _, hit := range result.hits {
			if hit.inScope(a.searchScope.GetUntracked()) {
				a.chooseSearchHit(result, hit)
				return
			}
		}
		return
	}
	if strings.TrimSpace(a.searchText.GetUntracked()) != "" {
		a.searchEnter = true
		a.runSearch()
	}
}

func (a *app) submitSearch(query string) {
	if query != a.searchText.GetUntracked() {
		a.setSearchQuery(query)
	}
	a.openSearchTop()
}

func (h searchHit) inScope(scope string) bool {
	switch scope {
	case "title":
		return h.InTitle
	case "body":
		return h.Count > 0
	default:
		return true
	}
}

func (result *searchResult) visible(scope string) []searchHit {
	hits := make([]searchHit, 0, min(searchVisibleLimit, len(result.hits)))
	for _, hit := range result.hits {
		if hit.inScope(scope) {
			hits = append(hits, hit)
			if len(hits) == searchVisibleLimit {
				break
			}
		}
	}
	return hits
}

func (a *app) rememberSearch(query string) {
	query = strings.TrimSpace(query)
	if query == "" {
		return
	}
	list := []string{query}
	for _, q := range a.cfg.RecentSearches {
		if q != query {
			list = append(list, q)
		}
	}
	if len(list) > 8 {
		list = list[:8]
	}
	a.cfg.RecentSearches = list
	a.searchRev.Update(func(n int) int { return n + 1 })
	if a.st != nil {
		a.st.edit(func(c *config) { c.RecentSearches = append([]string(nil), list...) })
	}
}

func (a *app) clearSearches() {
	a.cfg.RecentSearches = nil
	a.searchRev.Update(func(n int) int { return n + 1 })
	if a.st != nil {
		a.st.edit(func(c *config) { c.RecentSearches = nil })
	}
}

func (a *app) chooseSearchHit(result *searchResult, hit searchHit) {
	if a.searchResults.GetUntracked() != result || result.query != strings.TrimSpace(a.searchText.GetUntracked()) ||
		!hit.inScope(a.searchScope.GetUntracked()) {
		return
	}
	a.rememberSearch(a.searchText.GetUntracked())
	a.closeSearch()
	if s := a.byID[hit.ID]; s != nil {
		a.selectSession(s)
		return
	}
	if s := a.loadACPArchiveFile(hit.File); s != nil {
		a.selectSession(s)
		return
	}
	ws := a.workspaceOf(hit.Cwd)
	if ws == nil {
		a.addWorkspace(hit.Cwd)
		ws = a.workspaceOf(hit.Cwd)
	}
	if ws == nil {
		a.toast(ui.ToastError, "打不开这个会话", "它的项目目录不在本机。")
		return
	}
	meta := sessionMeta{ID: hit.ID, Cwd: hit.Cwd, File: hit.File, Title: hit.Title,
		Updated: hit.Updated, External: hit.External}
	s := a.makeSession(meta, localTarget)
	ws.Sessions.Update(func(ss []*session) []*session { return append([]*session{s}, ss...) })
	a.selectSession(s)
}
