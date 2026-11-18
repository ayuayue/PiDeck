//go:build !js && !android && !ios

package workbench

// The phone server and its network channels. The desktop app can expose
// its projects and sessions to the mobile build over HTTP; a token guards
// every request. The same page reports the addresses the phone can use on
// the LAN, over Tailscale or over EasyTier.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"example.com/pideck-lite/internal/remotewire"
	qrcode "github.com/skip2/go-qrcode"
)

// searchCache keeps each session file's text so a second search is cheap.
type searchCache struct {
	mu      sync.Mutex
	entries map[string]searchEntry
}

type searchEntry struct {
	mod  time.Time
	size int64
	text string
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
			if ws.Target.remote() || (project != "" && ws.Path != project) {
				continue
			}
			h.app.scanProject(ws)
			pinned, rest := h.app.projectSessions(ws)
			for _, s := range append(pinned, rest...) {
				if s == nil || s.File == "" {
					continue
				}
				targets = append(targets, target{id: s.ID, title: s.title.Get(), project: ws.label(), file: s.File})
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
		text := h.searchText(t.file)
		if text == "" {
			continue
		}
		at := strings.Index(text, query)
		if at < 0 {
			continue
		}
		hits = append(hits, remotewire.Hit{Session: t.id, Title: t.title, Project: t.project, Snippet: snippetAround(text, at, query)})
	}
	writeRemoteJSON(w, http.StatusOK, map[string]any{"hits": hits})
}

// searchText is a session file's messages, lowercased, kept between calls.
func (h *remoteHost) searchText(file string) string {
	info, err := os.Stat(file)
	if err != nil {
		return ""
	}
	if h.search == nil {
		h.search = &searchCache{entries: map[string]searchEntry{}}
	}
	h.search.mu.Lock()
	entry, ok := h.search.entries[file]
	h.search.mu.Unlock()
	if ok && entry.mod.Equal(info.ModTime()) && entry.size == info.Size() {
		return entry.text
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return ""
	}
	if len(raw) > 4<<20 {
		raw = raw[:4<<20]
	}
	var b strings.Builder
	sc := bufio.NewScanner(bytes.NewReader(raw))
	sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
	for sc.Scan() {
		var entry struct {
			Type    string          `json:"type"`
			Message json.RawMessage `json:"message"`
		}
		if json.Unmarshal(sc.Bytes(), &entry) != nil || entry.Type != "message" {
			continue
		}
		var msg piMessage
		if json.Unmarshal(entry.Message, &msg) != nil {
			continue
		}
		b.WriteString(msg.text())
		b.WriteByte(10)
		if b.Len() > 400<<10 {
			break
		}
	}
	text := strings.ToLower(b.String())
	h.search.mu.Lock()
	h.search.entries[file] = searchEntry{mod: info.ModTime(), size: info.Size(), text: text}
	h.search.mu.Unlock()
	return text
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
