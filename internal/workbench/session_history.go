//go:build !js && !android && !ios

package workbench

// Reading a session's transcript from its own file. pi stays the authority
// on what a session holds, but the file is on disk and needs no process: a
// tab paints its history while pi starts, and a phone asks for this instead
// of waking a session that is not open. Parses are kept by file version, so
// scrolling, re-opening a tab or polling from the phone reads the file once.

import (
	"encoding/json"
	"os"
	"sync"
	"time"
)

// historyBudget bounds the parses kept in memory, measured by the size of
// the files they came from: a long session is tens of megabytes of text.
const historyBudget = 64 << 20

// historyCacheMax bounds how many files are kept, however small they are.
const historyCacheMax = 8

// historyEntry is one file's parsed messages, and how much of the file that
// parse covers.
type historyEntry struct {
	size    int64
	modTime time.Time
	msgs    []piMessage
	tail    parsedTail
}

// sessionHistoryCache keeps the last few parses, newest last.
type sessionHistoryCache struct {
	sync.Mutex
	items map[string]historyEntry
	order []string
	bytes int64
}

var sessionHistory = &sessionHistoryCache{items: map[string]historyEntry{}}

// get returns the messages cached for a file, when it has not changed.
func (c *sessionHistoryCache) get(path string, info os.FileInfo) []piMessage {
	c.Lock()
	defer c.Unlock()
	entry, ok := c.items[path]
	if !ok || entry.size != info.Size() || !entry.modTime.Equal(info.ModTime()) {
		return nil
	}
	return entry.msgs
}

// previous returns what the last parse of a file left behind, so an append
// can be read from where it stopped.
func (c *sessionHistoryCache) previous(path string) (historyEntry, bool) {
	c.Lock()
	defer c.Unlock()
	entry, ok := c.items[path]
	return entry, ok
}

// put remembers a parse, dropping the oldest until it fits.
func (c *sessionHistoryCache) put(path string, info os.FileInfo, entry historyEntry) {
	c.Lock()
	defer c.Unlock()
	if old, ok := c.items[path]; ok {
		c.bytes -= old.size
		delete(c.items, path)
	}
	// The same file can be parsed twice at once; keep it once in order.
	kept := c.order[:0]
	for _, p := range c.order {
		if p != path {
			kept = append(kept, p)
		}
	}
	c.order = append(kept, path)
	entry.size, entry.modTime = info.Size(), info.ModTime()
	c.items[path] = entry
	c.bytes += info.Size()
	for len(c.order) > 1 && (c.bytes > historyBudget || len(c.items) > historyCacheMax) {
		oldest := c.order[0]
		c.order = c.order[1:]
		if entry, ok := c.items[oldest]; ok {
			c.bytes -= entry.size
			delete(c.items, oldest)
		}
	}
}

// sessionFileMessages reads the messages of a pi session file, reusing the
// parse while the file is unchanged and reading only the new tail when it
// grew. Callers treat the slice as read-only.
func sessionFileMessages(path string) ([]piMessage, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if msgs := sessionHistory.get(path, info); msgs != nil {
		return msgs, nil
	}
	prev, seen := sessionHistory.previous(path)
	start := int64(0)
	if seen {
		start = prev.tail.resumeAt(path, info.Size())
	}
	msgs, tail, err := readSessionMessages(path, start)
	if err != nil {
		return nil, err
	}
	if start > 0 {
		joined := make([]piMessage, 0, len(prev.msgs)+len(msgs))
		joined = append(joined, prev.msgs...)
		msgs = append(joined, msgs...)
	}
	sessionHistory.put(path, info, historyEntry{msgs: msgs, tail: tail})
	return msgs, nil
}

// readSessionMessages reads the message entries of a pi session file from
// start, and reports where it stopped.
func readSessionMessages(path string, start int64) ([]piMessage, parsedTail, error) {
	var msgs []piMessage
	tail, err := readTail(path, start, func(line []byte) error {
		if len(line) == 0 {
			return nil
		}
		var entry struct {
			Type    string          `json:"type"`
			Message json.RawMessage `json:"message"`
		}
		if json.Unmarshal(line, &entry) != nil || entry.Type != "message" || len(entry.Message) == 0 {
			return nil
		}
		var msg piMessage
		if json.Unmarshal(entry.Message, &msg) == nil {
			msgs = append(msgs, msg)
		}
		return nil
	})
	if err != nil {
		return nil, tail, err
	}
	return msgs, tail, nil
}
