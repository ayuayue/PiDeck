//go:build !js && !android && !ios

package workbench

// Config and session storage. The app keeps its own JSON config beside a
// private pi session directory, so browsing history never touches the
// sessions a terminal pi or PiDeck may have open.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"example.com/pideck-v2/internal/viewkit"
)

// metaRead is what reading one session file produced.
type metaRead struct {
	meta    sessionMeta
	ok      bool
	partial bool
	start   int64 // where the read began, 0 when the whole file was read
	tail    parsedTail
}

// readSessionMeta reads as much of one session file as a listing needs:
// its header always, and its messages when want accepts the folder it
// belongs to. A listing that stops at the header is partial and is read in
// full once its project is on screen.
//
// prev is what the last read of this file left behind: a file that only
// grew is read from where that one stopped, which is what keeps a start from
// re-reading a long session that was used yesterday.
func readSessionMeta(path string, prev metaCacheEntry, want func(cwd string) bool) metaRead {
	meta := sessionMeta{File: path}
	size := int64(0)
	if info, err := os.Stat(path); err == nil {
		size = info.Size()
		meta.Updated = info.ModTime()
	}
	start := int64(0)
	if prev.OK && !prev.Partial && prev.Meta.Title != "" {
		start = prev.Tail.resumeAt(path, size)
	}
	if start > 0 {
		meta = prev.Meta
		meta.File = path
	}
	firstUser := ""
	partial := false
	tail, err := readTail(path, start, func(line []byte) error {
		if len(line) == 0 {
			return nil
		}
		var entry struct {
			Type          string          `json:"type"`
			Timestamp     string          `json:"timestamp"`
			Cwd           string          `json:"cwd"`
			ID            string          `json:"id"`
			Name          string          `json:"name"`
			ParentSession string          `json:"parentSession"`
			Message       json.RawMessage `json:"message"`
		}
		if json.Unmarshal(line, &entry) != nil {
			return nil
		}
		if entry.Type == "session" {
			meta.Cwd, meta.ID = filepath.Clean(entry.Cwd), entry.ID
			meta.Parent = strings.TrimSpace(entry.ParentSession)
			// The header's time is when the session began; a file copied or
			// touched later still keeps it.
			if meta.Created.IsZero() {
				if t, err := time.Parse(time.RFC3339Nano, entry.Timestamp); err == nil {
					meta.Created = t
				}
			}
			if start == 0 && want != nil && meta.ID != "" && !want(meta.Cwd) {
				// The header is all this folder's files need.
				partial = true
				return errStopTail
			}
			return nil
		}
		if entry.Type == "session_info" && entry.Name != "" {
			meta.Title = entry.Name
		}
		if t, err := time.Parse(time.RFC3339Nano, entry.Timestamp); err == nil {
			meta.Updated = t
		}
		if entry.Type != "message" || len(entry.Message) == 0 {
			return nil
		}
		var msg piMessage
		if json.Unmarshal(entry.Message, &msg) != nil {
			return nil
		}
		meta.Count++
		if msg.Role == "user" && firstUser == "" {
			if text := strings.TrimSpace(msg.text()); text != "" && !strings.HasPrefix(text, "/") {
				firstUser = text
			} else if text != "" {
				firstUser = text
			}
		}
		return nil
	})
	read := metaRead{start: start, tail: tail}
	if err != nil && err != errStopTail {
		return read
	}
	if partial {
		read.meta, read.ok, read.partial = meta, true, true
		return read
	}
	if meta.ID == "" {
		return read
	}
	if meta.Title == "" && firstUser != "" {
		meta.Title = viewkit.FirstLine(firstUser, 48)
	}
	read.meta, read.ok = meta, true
	return read
}
