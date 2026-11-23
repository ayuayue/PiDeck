//go:build !js && !android && !ios

package workbench

// Favorites: local snapshots of an answer, and references to a session.
// A saved answer keeps its text even when the session file is gone; a
// saved session only keeps its id, so clicking it goes back to the live
// conversation. Everything lives in favorites.json beside the config.

import (
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
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

// favoriteList is a copy of the list for the UI.
func (a *app) favoriteList() []favoriteEntry {
	a.favMu.Lock()
	defer a.favMu.Unlock()
	out := make([]favoriteEntry, len(a.favorites))
	copy(out, a.favorites)
	return out
}

// addFavorite puts one entry first after it has been saved.
func (a *app) addFavorite(e favoriteEntry, after func(bool)) {
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
	a.editFavorites(func(entries []favoriteEntry) ([]favoriteEntry, bool) {
		for _, saved := range entries {
			if saved.Kind == e.Kind && saved.SessionID == e.SessionID &&
				(e.Kind == favoriteSession || saved.Text == e.Text) {
				return entries, false
			}
		}
		next := append([]favoriteEntry{e}, entries...)
		return next[:min(len(next), favoriteLimit)], true
	}, after)
}

// removeFavorite drops one entry only after the removal is saved.
func (a *app) removeFavorite(id string) {
	id = strings.TrimSpace(id)
	if id == "" {
		return
	}
	a.editFavorites(func(entries []favoriteEntry) ([]favoriteEntry, bool) {
		next := make([]favoriteEntry, 0, len(entries))
		for _, e := range entries {
			if e.ID != id {
				next = append(next, e)
			}
		}
		return next, len(next) != len(entries)
	}, func(removed bool) {
		if removed {
			a.toast(ui.ToastInfo, "已取消收藏", "")
		}
	})
}

// clearFavorites forgets everything only after the empty list is saved.
func (a *app) clearFavorites() {
	a.editFavorites(func(entries []favoriteEntry) ([]favoriteEntry, bool) {
		return nil, len(entries) > 0
	}, func(cleared bool) {
		if cleared {
			a.toast(ui.ToastInfo, "已清空收藏", "")
		}
	})
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
	e := favoriteEntry{Kind: favoriteReply, SessionID: s.ID, SessionTitle: s.title.GetUntracked(),
		Project: s.WS, Prompt: tt.Prompt, Text: text}
	a.addFavorite(e, func(added bool) {
		if !added {
			a.toast(ui.ToastInfo, "已经收藏过这条回复", "")
			return
		}
		a.toast(ui.ToastSuccess, "已收藏回复", viewkit.FirstLine(text, 60))
	})
}

// favoriteSession saves a reference to the conversation.
func (a *app) favoriteSession(s *session) {
	if s == nil {
		return
	}
	title := s.title.GetUntracked()
	e := favoriteEntry{Kind: favoriteSession, SessionID: s.ID, SessionTitle: title, Project: s.WS}
	a.addFavorite(e, func(added bool) {
		if !added {
			a.toast(ui.ToastInfo, "已经收藏过这个会话", "")
			return
		}
		a.toast(ui.ToastSuccess, "已收藏会话", title)
	})
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
	e := favoriteEntry{ID: newSessionID(), Kind: favoriteSession, SessionID: s.ID,
		SessionTitle: s.title.GetUntracked(), Project: s.WS, CreatedAt: a.cx.Now()}
	removed := false
	a.editFavorites(func(entries []favoriteEntry) ([]favoriteEntry, bool) {
		for i, saved := range entries {
			if saved.Kind == favoriteSession && saved.SessionID == e.SessionID {
				removed = true
				return append(entries[:i:i], entries[i+1:]...), true
			}
		}
		next := append([]favoriteEntry{e}, entries...)
		return next[:min(len(next), favoriteLimit)], true
	}, func(bool) {
		if removed {
			a.toast(ui.ToastInfo, "已移出收藏夹", "")
		} else {
			a.toast(ui.ToastSuccess, "已收藏会话", e.SessionTitle)
		}
	})
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
		return apptext.T("回复")
	case favoriteSession:
		return apptext.T("会话")
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
		return apptext.T("会话引用：点开回到原对话。")
	}
	return viewkit.FirstLine(e.Text, limit)
}

// favoriteKeyDown is a stable test id for an entry.
func favoriteKeyDown(e favoriteEntry) string { return "favorite-" + e.ID }

// favoriteCount is how many entries are saved.
func (a *app) favoriteCount() int {
	a.favMu.Lock()
	defer a.favMu.Unlock()
	return len(a.favorites)
}
