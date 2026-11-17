//go:build !js && !android && !ios

package main

// Favorites: local snapshots of an answer, and references to a session.
// A saved answer keeps its text even when the session file is gone; a
// saved session only keeps its id, so clicking it goes back to the live
// conversation. Everything lives in favorites.json beside the config.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/nsgo-dev/nsgo/ui"
)

// favoriteLimit bounds the list; adding past it drops the oldest entry.
// favoriteTextLimit bounds one saved answer, so a huge paste cannot make
// favorites.json unreadable.
const (
	favoriteLimit     = 200
	favoriteTextLimit = 64 << 10
)

// favorite kinds.
const (
	favoriteReply   = "reply"
	favoriteSession = "session"
)

// favoriteEntry is one saved item.
type favoriteEntry struct {
	ID           string    `json:"id"`
	Kind         string    `json:"kind"`
	SessionID    string    `json:"sessionId,omitempty"`
	SessionTitle string    `json:"sessionTitle,omitempty"`
	Project      string    `json:"project,omitempty"`
	Prompt       string    `json:"prompt,omitempty"`
	Text         string    `json:"text,omitempty"`
	CreatedAt    time.Time `json:"createdAt"`
}

// favoritesFile is what favorites.json holds.
type favoritesFile struct {
	Version int             `json:"version"`
	Entries []favoriteEntry `json:"entries"`
}

// favoritesPath is where the list lives.
func (a *app) favoritesPath() string {
	if a == nil || a.st == nil {
		return ""
	}
	return filepath.Join(a.st.dir, "favorites.json")
}

// loadFavorites reads the list, dropping entries that lost their shape.
func (a *app) loadFavorites() []favoriteEntry {
	path := a.favoritesPath()
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var file favoritesFile
	if json.Unmarshal(raw, &file) != nil {
		var list []favoriteEntry
		if json.Unmarshal(raw, &list) != nil {
			return nil
		}
		file.Entries = list
	}
	out := make([]favoriteEntry, 0, len(file.Entries))
	for _, e := range file.Entries {
		e.ID = strings.TrimSpace(e.ID)
		e.SessionID = strings.TrimSpace(e.SessionID)
		e.Kind = strings.TrimSpace(e.Kind)
		if e.ID == "" {
			continue
		}
		switch e.Kind {
		case favoriteReply:
			if strings.TrimSpace(e.Text) == "" {
				continue
			}
		case favoriteSession:
			if e.SessionID == "" {
				continue
			}
		default:
			continue
		}
		if len([]rune(e.Text)) > favoriteTextLimit {
			e.Text = string([]rune(e.Text)[:favoriteTextLimit]) + "\n… 已截断"
		}
		if e.CreatedAt.IsZero() {
			e.CreatedAt = time.Now()
		}
		out = append(out, e)
		if len(out) >= favoriteLimit {
			break
		}
	}
	return out
}

// saveFavorites writes the list atomically. The caller holds favMu.
func (a *app) saveFavoritesLocked() {
	path := a.favoritesPath()
	if path == "" {
		return
	}
	data, err := json.MarshalIndent(favoritesFile{Version: 1, Entries: a.favorites}, "", "  ")
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	_ = writeFileAtomic(path, data, 0o644)
}

// favoriteList is a copy of the list for the UI.
func (a *app) favoriteList() []favoriteEntry {
	a.favMu.Lock()
	defer a.favMu.Unlock()
	out := make([]favoriteEntry, len(a.favorites))
	copy(out, a.favorites)
	return out
}

// addFavorite puts one entry first and saves it.
func (a *app) addFavorite(e favoriteEntry) (favoriteEntry, error) {
	e.ID = strings.TrimSpace(e.ID)
	if e.ID == "" {
		e.ID = newSessionID()
	}
	if e.CreatedAt.IsZero() {
		e.CreatedAt = a.cx.Now()
	}
	if len([]rune(e.Text)) > favoriteTextLimit {
		e.Text = string([]rune(e.Text)[:favoriteTextLimit]) + "\n… 已截断"
	}
	a.favMu.Lock()
	a.favorites = append([]favoriteEntry{e}, a.favorites...)
	if len(a.favorites) > favoriteLimit {
		a.favorites = a.favorites[:favoriteLimit]
	}
	a.saveFavoritesLocked()
	a.favMu.Unlock()
	a.favRev.Update(func(n int) int { return n + 1 })
	return e, nil
}

// removeFavorite drops one entry.
func (a *app) removeFavorite(id string) bool {
	id = strings.TrimSpace(id)
	if id == "" {
		return false
	}
	removed := false
	a.favMu.Lock()
	out := a.favorites[:0]
	for _, e := range a.favorites {
		if e.ID == id {
			removed = true
			continue
		}
		out = append(out, e)
	}
	a.favorites = out
	if removed {
		a.saveFavoritesLocked()
	}
	a.favMu.Unlock()
	if removed {
		a.favRev.Update(func(n int) int { return n + 1 })
	}
	return removed
}

// clearFavorites forgets everything.
func (a *app) clearFavorites() {
	a.favMu.Lock()
	a.favorites = nil
	a.saveFavoritesLocked()
	a.favMu.Unlock()
	a.favRev.Update(func(n int) int { return n + 1 })
}

// favoriteReply saves a turn's answer, whole.
func (a *app) favoriteReply(s *session, tt turn) {
	if s == nil {
		return
	}
	text := strings.TrimSpace(tt.Final)
	if text == "" {
		for i := len(tt.Steps) - 1; i >= 0; i-- {
			if strings.TrimSpace(tt.Steps[i].Text) != "" {
				text = strings.TrimSpace(tt.Steps[i].Text)
				break
			}
		}
	}
	if text == "" {
		a.toast(ui.ToastInfo, "这条回复还没有内容", "等它答完再收藏。")
		return
	}
	a.favMu.Lock()
	for _, e := range a.favorites {
		if e.Kind == favoriteReply && e.SessionID == s.ID && e.Text == text {
			a.favMu.Unlock()
			a.toast(ui.ToastInfo, "已经收藏过这条回复", "")
			return
		}
	}
	a.favMu.Unlock()
	e := favoriteEntry{Kind: favoriteReply, SessionID: s.ID, SessionTitle: s.title.GetUntracked(),
		Project: s.WS, Prompt: tt.Prompt, Text: text}
	if _, err := a.addFavorite(e); err != nil {
		a.toast(ui.ToastError, "收藏失败", err.Error())
		return
	}
	a.toast(ui.ToastSuccess, "已收藏回复", firstLine(text, 60))
}

// favoriteSession saves a reference to the conversation.
func (a *app) favoriteSession(s *session) {
	if s == nil {
		return
	}
	a.favMu.Lock()
	for _, e := range a.favorites {
		if e.Kind == favoriteSession && e.SessionID == s.ID {
			a.favMu.Unlock()
			a.toast(ui.ToastInfo, "已经收藏过这个会话", "")
			return
		}
	}
	a.favMu.Unlock()
	e := favoriteEntry{Kind: favoriteSession, SessionID: s.ID, SessionTitle: s.title.GetUntracked(), Project: s.WS}
	if _, err := a.addFavorite(e); err != nil {
		a.toast(ui.ToastError, "收藏失败", err.Error())
		return
	}
	a.toast(ui.ToastSuccess, "已收藏会话", s.title.GetUntracked())
}

// isSessionFavorite reports whether the conversation is saved.
func (a *app) isSessionFavorite(id string) bool {
	if id == "" {
		return false
	}
	a.favMu.Lock()
	defer a.favMu.Unlock()
	for _, e := range a.favorites {
		if e.Kind == favoriteSession && e.SessionID == id {
			return true
		}
	}
	return false
}

// toggleSessionFavorite stores a reference, or takes it out again.
func (a *app) toggleSessionFavorite(s *session) {
	if s == nil {
		return
	}
	a.favMu.Lock()
	for i, e := range a.favorites {
		if e.Kind == favoriteSession && e.SessionID == s.ID {
			a.favorites = append(a.favorites[:i], a.favorites[i+1:]...)
			a.saveFavoritesLocked()
			a.favMu.Unlock()
			a.favRev.Update(func(n int) int { return n + 1 })
			a.toast(ui.ToastInfo, "已移出收藏夹", "")
			return
		}
	}
	a.favMu.Unlock()
	a.favoriteSession(s)
}

// openFavorite jumps back to the conversation a favorite came from.
func (a *app) openFavorite(f favoriteEntry) {
	if strings.TrimSpace(f.SessionID) == "" {
		a.toast(ui.ToastInfo, "这条收藏没有关联会话", "")
		return
	}
	s := a.findSession(f.SessionID)
	if s == nil {
		a.toast(ui.ToastWarning, "找不到原来的会话", "会话可能已经被删除；收藏的回复仍留在收藏夹里。")
		return
	}
	a.selectSession(s)
}

// favoriteKindLabel names a kind for the list.
func favoriteKindLabel(kind string) string {
	switch kind {
	case favoriteReply:
		return T("回复")
	case favoriteSession:
		return T("会话")
	}
	return kind
}

// favoriteSubtitle is the row's second line.
func (a *app) favoriteSubtitle(e favoriteEntry) string {
	where := e.SessionTitle
	if where == "" {
		where = e.SessionID
	}
	if e.Project != "" {
		where = projectLabel(e.Project) + " · " + where
	}
	return where
}

// favoriteWhen formats the saved time.
func favoriteWhen(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format("2006-01-02 15:04")
}

// favoriteSummary is the one-line preview of an entry.
func favoriteSummary(e favoriteEntry, limit int) string {
	if e.Kind == favoriteSession {
		return T("会话引用：点开回到原对话。")
	}
	return firstLine(e.Text, limit)
}

// favoriteKeyDown is a stable test id for an entry.
func favoriteKeyDown(e favoriteEntry) string { return "favorite-" + e.ID }

// favoriteCount is how many entries are saved.
func (a *app) favoriteCount() int {
	a.favMu.Lock()
	defer a.favMu.Unlock()
	return len(a.favorites)
}
