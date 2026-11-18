//go:build !js && !android && !ios

package workbench

// Config and session storage. The app keeps its own JSON config beside a
// private pi session directory, so browsing history never touches the
// sessions a terminal pi or PiDeck may have open.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// store holds the config file and the session directory.
type store struct {
	dir      string // app data
	sessions string // private pi session directory
	path     string // config.json
	mu       sync.Mutex
	c        *config
	// metas caches the listing of each session file, keyed by path, so a
	// rescan only reads files whose size or modification time changed.
	metas map[string]metaCacheEntry
	// parses counts the session files actually read, and consumed the bytes
	// those reads took, which lets a test see the cache and the tail reads
	// doing their work.
	parses   int
	consumed int64
	// metaPath is where the listings are kept between runs, so a start
	// reads no session file at all. metaDirty marks a change not yet
	// written, and metaWriteMu keeps two writers off one temporary file.
	metaPath    string
	metaDirty   bool
	metaWriteMu sync.Mutex
}

// metaCacheEntry is one file's cached listing. Partial marks a listing
// that read only the session header, because its project was off screen.
type metaCacheEntry struct {
	Size    int64       `json:"size"`
	ModTime time.Time   `json:"mtime"`
	Meta    sessionMeta `json:"meta"`
	OK      bool        `json:"ok"`
	Partial bool        `json:"partial,omitempty"`
	// Tail is how much of the file the listing covers, so an appended file
	// is read from there instead of from the top.
	Tail parsedTail `json:"tail,omitempty"`
}

func newStore(dataDir string) (*store, error) {
	s := &store{
		dir:      dataDir,
		sessions: filepath.Join(dataDir, "sessions"),
		path:     filepath.Join(dataDir, "config.json"),
		metaPath: filepath.Join(dataDir, "session-meta-cache.json"),
		c: &config{Version: configVersion, SidebarOpen: true, Theme: "system", Titles: map[string]string{}, ScanPi: true,
			CloseToTray: true, NotifyOnDone: true, NotifyOnlyHidden: true},
	}
	if err := os.MkdirAll(s.sessions, 0o755); err != nil {
		return nil, err
	}
	s.loadMetaCache()
	if raw, err := os.ReadFile(s.path); err == nil {
		var c config
		if json.Unmarshal(raw, &c) == nil {
			if c.Titles == nil {
				c.Titles = map[string]string{}
			}
			changed := migrateConfig(&c, raw)
			s.c = &c
			if changed {
				_ = s.save()
			}
		}
	}
	return s, nil
}
