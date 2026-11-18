//go:build !js && !android && !ios

package workbench

// Config and session storage. The app keeps its own JSON config beside a
// private pi session directory, so browsing history never touches the
// sessions a terminal pi or PiDeck may have open.

import (
	"encoding/json"
	"os"
	"time"
)

// sessionMeta is a session as the sidebar and tabs need it before its
// process starts. It is what session-meta-cache.json keeps, so its fields
// are tagged and File travels as the map key instead.
type sessionMeta struct {
	ID      string    `json:"id"`
	Cwd     string    `json:"cwd"`
	File    string    `json:"-"`
	Title   string    `json:"title,omitempty"`
	Updated time.Time `json:"updated"`
	Count   int       `json:"count,omitempty"`
	Target  string    `json:"target,omitempty"`
	// External marks a session in pi's own store, which the app opens in
	// place rather than owning.
	External bool `json:"-"`
}

// metaCacheVersion is the shape of session-meta-cache.json. Bump it when a
// field means something else, and every file is read again once.
const metaCacheVersion = 2

// metaCacheMax bounds the listings kept, as the scan itself is bounded.
const metaCacheMax = 8000

// metaCacheFile is what session-meta-cache.json holds.
type metaCacheFile struct {
	Version int                       `json:"version"`
	Entries map[string]metaCacheEntry `json:"entries"`
}

// metaResult is one file's listing, or that it has none.
type metaResult struct {
	meta sessionMeta
	ok   bool
}

// loadMetaCache restores the listings the last run left behind, so a
// warm start reads no session file at all. A missing, corrupt or older
// cache is simply a cold start.
func (s *store) loadMetaCache() {
	raw, err := os.ReadFile(s.metaPath)
	if err != nil {
		return
	}
	var f metaCacheFile
	if json.Unmarshal(raw, &f) != nil || f.Version != metaCacheVersion || len(f.Entries) == 0 || len(f.Entries) > metaCacheMax {
		return
	}
	for path, e := range f.Entries {
		if e.ModTime.IsZero() {
			delete(f.Entries, path)
			continue
		}
		e.Meta.File = path
		f.Entries[path] = e
	}
	s.mu.Lock()
	s.metas = f.Entries
	s.mu.Unlock()
}

// writeMetaCache writes the listings as they are now, atomically, so a
// half-written cache is never read.
func (s *store) writeMetaCache() {
	s.metaWriteMu.Lock()
	defer s.metaWriteMu.Unlock()
	s.mu.Lock()
	f := metaCacheFile{Version: metaCacheVersion, Entries: make(map[string]metaCacheEntry, len(s.metas))}
	for path, e := range s.metas {
		f.Entries[path] = e
	}
	s.metaDirty = false
	s.mu.Unlock()
	raw, err := json.Marshal(f)
	if err != nil {
		return
	}
	tmp := s.metaPath + ".tmp"
	if os.WriteFile(tmp, raw, 0o644) != nil {
		return
	}
	_ = os.Rename(tmp, s.metaPath)
}

// saveMetaCache writes the listings when a scan changed them, so the next
// start reads no session file at all. A failed write costs one slow start.
func (s *store) saveMetaCache() {
	s.mu.Lock()
	dirty := s.metaDirty
	s.mu.Unlock()
	if dirty {
		s.writeMetaCache()
	}
}
