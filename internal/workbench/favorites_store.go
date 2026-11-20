//go:build !js && !android && !ios

package workbench

// Favorites keep their existing JSON format. Changes are persisted in request
// order off the UI thread, then published only after the file is complete.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/nsgo-dev/nsgo/ui"
)

var favoriteWrites sync.WaitGroup

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

// writeFavorites publishes one complete list using the shared atomic writer.
func writeFavorites(path string, entries []favoriteEntry) error {
	if path == "" {
		return errors.New("找不到数据目录")
	}
	data, err := json.MarshalIndent(favoritesFile{Version: 1, Entries: entries}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return writeFileAtomic(path, data, 0o644)
}

// editFavorites chains each change to the last successfully persisted list.
// The channel transfers a snapshot, including on failure, so a later change
// cannot accidentally save an earlier change that the user was told failed.
// Called on the UI thread; after runs there only when persistence succeeded.
func (a *app) editFavorites(edit func([]favoriteEntry) ([]favoriteEntry, bool), after func(bool)) {
	path := a.favoritesPath()
	entries := a.favoriteList()
	previous := a.favWriteTail
	done := make(chan []favoriteEntry, 1)
	a.favWriteTail = done
	favoriteWrites.Add(1)
	go func() {
		defer favoriteWrites.Done()
		if previous != nil {
			entries = slices.Clone(<-previous)
		}
		next, changed := edit(entries)
		var err error
		if changed {
			err = writeFavorites(path, next)
		}
		if err != nil || !changed {
			next = entries
		}
		a.cx.Post(func() {
			if a.favWriteTail == done {
				a.favWriteTail = nil
			}
			if err != nil {
				a.toast(ui.ToastError, "保存失败", err.Error())
				return
			}
			if changed {
				a.favMu.Lock()
				a.favorites = next
				a.favMu.Unlock()
				a.favRev.Update(func(n int) int { return n + 1 })
			}
			if after != nil {
				after(changed)
			}
		})
		// Post before releasing the next writer, preserving publication order.
		done <- next
	}()
}
