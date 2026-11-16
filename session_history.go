//go:build !js && !android && !ios

package main

// Reading a session's transcript from its own file. pi stays the authority
// on what a session holds, but the file is on disk and needs no process: a
// tab paints its history while pi starts, and a phone asks for this instead
// of waking a session that is not open. Parses are kept by file version, so
// scrolling, re-opening a tab or polling from the phone reads the file once.

import (
	"bufio"
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

// historyEntry is one file's parsed messages.
type historyEntry struct {
	size    int64
	modTime time.Time
	msgs    []piMessage
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

// put remembers a parse, dropping the oldest until it fits.
func (c *sessionHistoryCache) put(path string, info os.FileInfo, msgs []piMessage) {
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
	c.items[path] = historyEntry{size: info.Size(), modTime: info.ModTime(), msgs: msgs}
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
// parse while the file is unchanged. Callers treat the slice as read-only.
func sessionFileMessages(path string) ([]piMessage, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if msgs := sessionHistory.get(path, info); msgs != nil {
		return msgs, nil
	}
	msgs, err := readSessionMessages(path)
	if err != nil {
		return nil, err
	}
	sessionHistory.put(path, info, msgs)
	return msgs, nil
}

// readSessionMessages reads the message entries of a pi session file.
func readSessionMessages(path string) ([]piMessage, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
	var msgs []piMessage
	for sc.Scan() {
		var entry struct {
			Type    string          `json:"type"`
			Message json.RawMessage `json:"message"`
		}
		if json.Unmarshal(sc.Bytes(), &entry) != nil || entry.Type != "message" || len(entry.Message) == 0 {
			continue
		}
		var msg piMessage
		if json.Unmarshal(entry.Message, &msg) == nil {
			msgs = append(msgs, msg)
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return msgs, nil
}
