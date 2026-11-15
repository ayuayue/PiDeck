package main

// Searching every session's title and text. The index is built once from
// the session files, capped per session, and kept in memory; a query then
// scans it without touching the disk.

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/nsgo-dev/nsgo/ui"
)

// searchDoc is one session in the index.
type searchDoc struct {
	ID       string
	Title    string
	Cwd      string
	File     string
	External bool
	Updated  time.Time
	Text     string
}

// searchHit is one result: the session, the matched snippet and how many
// times the query occurs.
type searchHit struct {
	ID       string
	Title    string
	Cwd      string
	File     string
	External bool
	Updated  time.Time
	Snippet  string
	Count    int
	InTitle  bool
}

// searchTextLimit caps what one session contributes, in bytes.
const searchTextLimit = 16 << 10

// searchFileLimit caps how many session files are indexed.
const searchFileLimit = 3000

// buildSearchIndex reads the newest session files under roots.
func buildSearchIndex(roots []string, acpDir string) []searchDoc {
	type fileInfo struct {
		path string
		mod  time.Time
	}
	var files []fileInfo
	seen := map[string]bool{}
	for _, root := range roots {
		if root == "" {
			continue
		}
		_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(strings.ToLower(d.Name()), ".jsonl") {
				return nil
			}
			clean := filepath.Clean(path)
			if seen[clean] {
				return nil
			}
			seen[clean] = true
			info, err := d.Info()
			if err != nil {
				return nil
			}
			files = append(files, fileInfo{path: clean, mod: info.ModTime()})
			return nil
		})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod.After(files[j].mod) })
	if len(files) > searchFileLimit {
		files = files[:searchFileLimit]
	}
	var docs []searchDoc
	seenID := map[string]bool{}
	for _, d := range buildACPSearchDocs(acpDir) {
		if seenID[d.ID] {
			continue
		}
		seenID[d.ID] = true
		docs = append(docs, d)
	}
	for _, f := range files {
		doc, ok := readSearchDoc(f.path)
		if !ok || seenID[doc.ID] {
			continue
		}
		seenID[doc.ID] = true
		docs = append(docs, doc)
	}
	return docs
}

// buildACPSearchDocs indexes the ACP archives.
func buildACPSearchDocs(dir string) []searchDoc {
	if dir == "" {
		return nil
	}
	entries, _ := os.ReadDir(dir)
	var out []searchDoc
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".json") {
			continue
		}
		path := filepath.Join(dir, e.Name())
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var arch acpArchive
		if json.Unmarshal(raw, &arch) != nil || arch.ID == "" || arch.Cwd == "" {
			continue
		}
		var text strings.Builder
		for _, t := range arch.Turns {
			if t.Prompt != "" {
				text.WriteString("用户：" + t.Prompt + "\n")
			}
			for _, st := range t.Steps {
				if st.Thinking != "" {
					text.WriteString(st.Thinking + "\n")
				}
				if st.Text != "" {
					text.WriteString(st.Text + "\n")
				}
				for _, tool := range st.Tools {
					text.WriteString(tool.Name + " " + tool.Detail + " " + tool.Output + "\n")
				}
			}
			if t.Final != "" {
				text.WriteString(t.Final + "\n")
			}
			if text.Len() > searchTextLimit {
				break
			}
		}
		title := arch.Title
		if title == "" {
			title = "ACP 会话"
		}
		body := text.String()
		if len(body) > searchTextLimit {
			body = body[:searchTextLimit]
		}
		out = append(out, searchDoc{ID: arch.ID, Title: title, Cwd: arch.Cwd, File: path,
			Updated: arch.Updated, Text: body})
	}
	return out
}

// readSearchDoc reads one session's title and a bounded text.
func readSearchDoc(path string) (searchDoc, bool) {
	f, err := os.Open(path)
	if err != nil {
		return searchDoc{}, false
	}
	defer f.Close()
	doc := searchDoc{File: path}
	if info, err := f.Stat(); err == nil {
		doc.Updated = info.ModTime()
	}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
	var text strings.Builder
	firstUser := ""
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var entry struct {
			Type      string          `json:"type"`
			Timestamp string          `json:"timestamp"`
			Cwd       string          `json:"cwd"`
			ID        string          `json:"id"`
			Name      string          `json:"name"`
			Message   json.RawMessage `json:"message"`
		}
		if json.Unmarshal(line, &entry) != nil {
			continue
		}
		switch entry.Type {
		case "session":
			doc.ID, doc.Cwd = entry.ID, filepath.Clean(entry.Cwd)
		case "session_info":
			if entry.Name != "" {
				doc.Title = entry.Name
			}
		case "message":
			var msg piMessage
			if json.Unmarshal(entry.Message, &msg) != nil {
				continue
			}
			if msg.Role != "user" && msg.Role != "assistant" {
				continue
			}
			body := strings.TrimSpace(msg.text())
			if body == "" {
				continue
			}
			if msg.Role == "user" && firstUser == "" {
				firstUser = body
			}
			if text.Len() < searchTextLimit {
				text.WriteString(body)
				text.WriteByte('\n')
			}
		}
		if t, err := time.Parse(time.RFC3339Nano, entry.Timestamp); err == nil && t.After(doc.Updated) {
			doc.Updated = t
		}
	}
	if doc.ID == "" {
		return searchDoc{}, false
	}
	if doc.Title == "" {
		doc.Title = firstLine(firstUser, 48)
	}
	if doc.Title == "" {
		doc.Title = "未命名会话"
	}
	doc.Text = text.String()
	if len(doc.Text) > searchTextLimit {
		doc.Text = doc.Text[:searchTextLimit]
	}
	return doc, true
}

// matchSearch finds the query in titles and text, best first.
func matchSearch(docs []searchDoc, query string, limit int) []searchHit {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return nil
	}
	var hits []searchHit
	for _, d := range docs {
		inTitle := strings.Contains(strings.ToLower(d.Title), q)
		lower := strings.ToLower(d.Text)
		count := strings.Count(lower, q)
		if !inTitle && count == 0 {
			continue
		}
		snippet := ""
		if idx := strings.Index(lower, q); idx >= 0 {
			snippet = searchSnippet(d.Text, idx, 70)
		}
		if snippet == "" && inTitle {
			snippet = firstLine(d.Text, 100)
		}
		hits = append(hits, searchHit{ID: d.ID, Title: d.Title, Cwd: d.Cwd, File: d.File,
			External: d.External, Updated: d.Updated, Snippet: snippet, Count: count, InTitle: inTitle})
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].InTitle != hits[j].InTitle {
			return hits[i].InTitle
		}
		if hits[i].Updated != hits[j].Updated {
			return hits[i].Updated.After(hits[j].Updated)
		}
		return hits[i].Title < hits[j].Title
	})
	if limit > 0 && len(hits) > limit {
		hits = hits[:limit]
	}
	return hits
}

// searchSnippet cuts a one-line window around a byte offset.
func searchSnippet(text string, at, width int) string {
	runes := []rune(text)
	runeAt := len([]rune(text[:at]))
	start := max(0, runeAt-width)
	end := min(len(runes), runeAt+width)
	piece := strings.Join(strings.Fields(string(runes[start:end])), " ")
	if start > 0 {
		piece = "…" + piece
	}
	if end < len(runes) {
		piece += "…"
	}
	return piece
}

// loadSearchIndex builds the index in the background and runs then on the
// UI thread.
func (a *app) loadSearchIndex(then func()) {
	if a.searchIndexed {
		if then != nil {
			then()
		}
		return
	}
	if a.searchBuilding {
		return
	}
	a.searchBuilding = true
	a.searchBusy.Set(true)
	roots := []string{}
	if a.st != nil {
		roots = append(roots, a.st.sessions)
	}
	if dir := a.env.GetUntracked().SessionsDir; dir != "" {
		roots = append(roots, dir)
	} else if dir := piSessionsDir(); dir != "" {
		roots = append(roots, dir)
	}
	go func() {
		docs := buildSearchIndex(roots, a.acpArchiveDir())
		a.cx.Post(func() {
			a.searchDocs = docs
			a.searchIndexed = true
			a.searchBuilding = false
			a.searchBusy.Set(false)
			if then != nil {
				then()
			} else {
				a.runSearch()
			}
		})
	}()
}

// openSearch shows the dialog and starts building the index.
func (a *app) openSearch() {
	a.searchText.Set("")
	a.searchHits.Set(nil)
	a.searchOpen.Set(true)
	a.loadSearchIndex(nil)
}

// scheduleSearch runs the query after a short pause.
func (a *app) scheduleSearch() {
	a.searchGen++
	gen := a.searchGen
	time.AfterFunc(250*time.Millisecond, func() {
		a.cx.Post(func() {
			if gen != a.searchGen {
				return
			}
			a.runSearch()
		})
	})
}

// runSearch filters the index now.
func (a *app) runSearch() {
	if !a.searchIndexed {
		a.loadSearchIndex(func() { a.runSearch() })
		return
	}
	q := a.searchText.GetUntracked()
	a.searchHits.Set(matchSearch(a.searchDocs, q, 60))
}

// rememberSearch keeps a query among the recent ones, newest first.
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

// clearSearches forgets the recent queries.
func (a *app) clearSearches() {
	a.cfg.RecentSearches = nil
	a.searchRev.Update(func(n int) int { return n + 1 })
	if a.st != nil {
		a.st.edit(func(c *config) { c.RecentSearches = nil })
	}
}

// openSearchHit opens the session a result names, creating it in the rail
// when it is not there yet.
func (a *app) openSearchHit(hit searchHit) {
	a.rememberSearch(a.searchText.GetUntracked())
	a.searchOpen.Set(false)
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

// searchVisible is the hits the dialog shows, after the scope chips.
func (a *app) searchVisible() []searchHit {
	return searchVisibleOf(a.searchHits.Get(), a.searchScope.Get())
}

// searchVisibleNow is the same list, read outside a render.
func (a *app) searchVisibleNow() []searchHit {
	return searchVisibleOf(a.searchHits.GetUntracked(), a.searchScope.GetUntracked())
}

func searchVisibleOf(hits []searchHit, scope string) []searchHit {
	var out []searchHit
	for _, h := range hits {
		switch scope {
		case "title":
			if !h.InTitle {
				continue
			}
		case "body":
			if h.Count == 0 {
				continue
			}
		}
		out = append(out, h)
	}
	return out
}

// openSearchTop opens the first hit of the search, as Enter does.
func (a *app) openSearchTop() {
	hits := a.searchVisibleNow()
	if len(hits) == 0 {
		return
	}
	a.openSearchHit(hits[0])
}
