//go:build !js && !android && !ios

package workbench

// The phone server and its network channels. The desktop app can expose
// its projects and sessions to the mobile build over HTTP; a token guards
// every request. The same page reports the addresses the phone can use on
// the LAN, over Tailscale or over EasyTier.

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"example.com/pideck-v2/internal/remotewire"
	qrcode "github.com/skip2/go-qrcode"
)

// searchCache keeps each session file's text so a second search is cheap. It
// counts bytes rather than entries: one file's text is its transcript up to
// the reader's own limit, and a phone searching a library of long sessions
// would otherwise leave hundreds of megabytes in the desktop's heap. The file
// asked for least recently goes first.
type searchCache struct {
	mu      sync.Mutex
	entries map[string]searchEntry
	bytes   int64
	tick    int64
}

// searchCacheBudget is how much transcript text the cache may hold.
const searchCacheBudget = 32 << 20

type searchEntry struct {
	mod  time.Time
	size int64
	text string
	used int64
}

// handleSearch looks for a word in the messages of every session file.
func (h *remoteHost) handleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	query := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	if len([]rune(query)) < 2 {
		writeRemoteJSON(w, http.StatusBadRequest, map[string]string{"error": "至少输入两个字"})
		return
	}
	project := r.URL.Query().Get("project")

	type target struct {
		id, title, project, file string
	}
	var targets []target
	ok := h.app.withUI(func() {
		for _, ws := range h.app.workspaces.GetUntracked() {
			if project != "" && projectWireKey(ws) != project {
				continue
			}
			h.app.scanProject(ws)
			pinned, rest := h.app.projectSessions(ws)
			for _, s := range append(pinned, rest...) {
				if s == nil {
					continue
				}
				file := s.File
				if s.backend == "acp" {
					file = filepath.Join(h.app.acpArchiveDir(), archiveName(s.ID))
				} else if s.Target.remote() {
					file = ""
				}
				targets = append(targets, target{id: s.ID, title: s.title.Get(), project: ws.label(), file: file})
			}
		}
	})
	if !ok {
		writeRemoteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "界面正忙，请稍后再试"})
		return
	}

	hits := make([]remotewire.Hit, 0, 20)
	for _, t := range targets {
		if len(hits) >= 30 {
			break
		}
		text := ""
		if t.file != "" {
			text = h.searchText(t.file)
		}
		at := strings.Index(text, query)
		if at < 0 && !containsQuery(t.title, query) {
			continue
		}
		snippet := t.title
		if at >= 0 {
			snippet = snippetAround(text, at, query)
		}
		hits = append(hits, remotewire.Hit{Session: t.id, Title: t.title, Project: t.project, Snippet: snippet})
	}
	writeRemoteJSON(w, http.StatusOK, map[string]any{"hits": hits})
}

// searchText is a session file's messages, lowercased, kept between calls.
func (h *remoteHost) searchText(file string) string {
	info, err := os.Stat(file)
	if err != nil {
		return ""
	}
	if text, ok := h.search.lookup(file, info); ok {
		return text
	}
	f, err := os.Open(file)
	if err != nil {
		return ""
	}
	defer f.Close()
	text := strings.ToLower(readSearchTranscript(f, filepath.Ext(file) == ".json"))
	h.search.store(file, info, text)
	return text
}

// lookup returns a file's text while the file is unchanged, and marks it as
// the one used last.
func (c *searchCache) lookup(file string, info os.FileInfo) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[file]
	if !ok || !entry.mod.Equal(info.ModTime()) || entry.size != info.Size() {
		return "", false
	}
	c.tick++
	entry.used = c.tick
	c.entries[file] = entry
	return entry.text, true
}

// store keeps a file's text, dropping the least recently used files until the
// cache fits its budget again. A file whose text alone is over the budget is
// dropped too: holding it would break the bound the phone's searches need.
func (c *searchCache) store(file string, info os.FileInfo, text string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if old, ok := c.entries[file]; ok {
		c.bytes -= int64(len(old.text))
		delete(c.entries, file)
	}
	c.tick++
	c.entries[file] = searchEntry{mod: info.ModTime(), size: info.Size(), text: text, used: c.tick}
	c.bytes += int64(len(text))
	for c.bytes > searchCacheBudget {
		c.dropOldest()
	}
}

// dropOldest forgets the file used least recently.
func (c *searchCache) dropOldest() {
	oldest, oldestAt := "", int64(0)
	for file, entry := range c.entries {
		if oldest == "" || entry.used < oldestAt {
			oldest, oldestAt = file, entry.used
		}
	}
	c.bytes -= int64(len(c.entries[oldest].text))
	delete(c.entries, oldest)
}

// clear forgets every file, so the settings page's cleanup takes the text and
// the parsed transcripts together.
func (c *searchCache) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries, c.bytes, c.tick = map[string]searchEntry{}, 0, 0
}

func readSearchTranscript(r io.Reader, acp bool) string {
	var b strings.Builder
	const textLimit = 400 << 10
	appendText := func(text string) {
		n := min(len(text), textLimit-b.Len())
		b.WriteString(text[:n])
		if b.Len() < textLimit {
			b.WriteByte('\n')
		}
	}
	if acp {
		var archive acpArchive
		if json.NewDecoder(io.LimitReader(r, acpArchiveBytes)).Decode(&archive) != nil {
			return ""
		}
		for _, t := range archive.Turns {
			appendText(t.Prompt)
			appendText(t.Final)
			if b.Len() >= textLimit {
				break
			}
		}
		return b.String()
	}
	sc := bufio.NewScanner(io.LimitReader(r, 4<<20))
	sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
	for sc.Scan() {
		var entry struct {
			Type    string          `json:"type"`
			Message json.RawMessage `json:"message"`
		}
		if json.Unmarshal(sc.Bytes(), &entry) != nil || entry.Type != "message" {
			continue
		}
		var msg piMessage
		if json.Unmarshal(entry.Message, &msg) != nil || (msg.Role != "user" && msg.Role != "assistant") {
			continue
		}
		appendText(msg.text())
		if b.Len() >= textLimit {
			break
		}
	}
	return b.String()
}

// snippetAround is the text around a match, on one line.
func snippetAround(text string, at int, query string) string {
	start := at - 40
	if start < 0 {
		start = 0
	}
	end := at + len(query) + 60
	if end > len(text) {
		end = len(text)
	}
	cut := text[start:end]
	cut = strings.Join(strings.Fields(cut), " ")
	if start > 0 {
		cut = "…" + cut
	}
	if end < len(text) {
		cut += "…"
	}
	return cut
}

// qrPNGFor encodes a link as a QR code image.
func qrPNGFor(link string) []byte {
	if link == "" {
		return nil
	}
	png, err := qrcode.Encode(link, qrcode.Medium, 480)
	if err != nil {
		return nil
	}
	return png
}
