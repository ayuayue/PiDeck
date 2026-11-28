//go:build !js && !android && !ios

package workbench

// Reading a session's transcript from its own file. pi stays the authority
// on what a session holds, but the file is on disk and needs no process: a
// tab paints its history while pi starts, and a phone asks for this instead
// of waking a session that is not open. Parses are kept by file version, so
// scrolling, re-opening a tab or polling from the phone reads the file once.

import (
	"bytes"
	"encoding/json"
	"maps"
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
	size     int64
	modTime  time.Time
	msgs     []piMessage
	model    modelInfo
	thinking string
	// view is msgs as the session's context edits leave it: entries taken
	// out of the context are gone, rewritten ones carry their new text.
	view  []piMessage
	edits map[string]contextEdit
	tail  parsedTail
	phone func() []turn
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
func (c *sessionHistoryCache) get(path string, info os.FileInfo) (historyEntry, bool) {
	c.Lock()
	defer c.Unlock()
	entry, ok := c.items[path]
	if !ok || entry.size != info.Size() || !entry.modTime.Equal(info.ModTime()) {
		return historyEntry{}, false
	}
	return entry, true
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
	entry, err := sessionFileHistory(path)
	return entry.view, err
}

func sessionFileHistory(path string) (historyEntry, error) {
	info, err := os.Stat(path)
	if err != nil {
		return historyEntry{}, err
	}
	if entry, ok := sessionHistory.get(path, info); ok {
		return entry, nil
	}
	prev, seen := sessionHistory.previous(path)
	start := int64(0)
	if seen {
		start = prev.tail.resumeAt(path, info.Size())
	}
	entry, err := readSessionMessages(path, start)
	if err != nil {
		return historyEntry{}, err
	}
	if start > 0 {
		joined := make([]piMessage, 0, len(prev.msgs)+len(entry.msgs))
		joined = append(joined, prev.msgs...)
		entry.msgs = append(joined, entry.msgs...)
		if entry.model.ID == "" {
			entry.model = prev.model
		}
		if entry.thinking == "" {
			entry.thinking = prev.thinking
		}
		// An edit appended later still speaks about messages read earlier.
		merged := maps.Clone(prev.edits)
		if merged == nil {
			merged = map[string]contextEdit{}
		}
		maps.Copy(merged, entry.edits)
		entry.edits = merged
	}
	view := applyContextEdits(entry.msgs, entry.edits)
	entry.view = view
	entry.phone = sync.OnceValue(func() []turn {
		return turnsFromMessages(view[max(0, len(view)-4000):])
	})
	sessionHistory.put(path, info, entry)
	return entry, nil
}

// readSessionMessages reads the transcript and saved settings from start,
// and reports where it stopped.
func readSessionMessages(path string, start int64) (historyEntry, error) {
	var entry historyEntry
	tail, err := readTail(path, start, func(line []byte) error {
		entry.readLine(line)
		return nil
	})
	entry.tail = tail
	return entry, err
}

// readLine keeps settings in file order, including changes after the last reply.
func (entry *historyEntry) readLine(line []byte) {
	if msg, ok := historyLineMessage(line); ok {
		entry.msgs = append(entry.msgs, msg)
		if msg.Role == "assistant" && msg.Model != "" {
			entry.model = modelInfo{ID: msg.Model, Provider: msg.Provider}
		}
		return
	}
	if edit, ok := historyLineContextEdit(line); ok {
		if entry.edits == nil {
			entry.edits = map[string]contextEdit{}
		}
		entry.edits[edit.Target] = edit
		return
	}
	var change struct {
		Type          string `json:"type"`
		Provider      string `json:"provider"`
		ModelID       string `json:"modelId"`
		ThinkingLevel string `json:"thinkingLevel"`
	}
	if json.Unmarshal(line, &change) != nil {
		return
	}
	switch change.Type {
	case "model_change":
		if change.ModelID != "" {
			entry.model = modelInfo{ID: change.ModelID, Provider: change.Provider}
		}
	case "thinking_level_change":
		if change.ThinkingLevel != "" {
			entry.thinking = change.ThinkingLevel
		}
	}
}

// historyLineContextEdit reads one of pi's context_edit records: the entry
// it speaks about, and what stands in its place.
func historyLineContextEdit(line []byte) (contextEdit, bool) {
	if !bytes.Contains(line, []byte(contextEditType)) {
		return contextEdit{}, false
	}
	var entry struct {
		Type        string          `json:"type"`
		TargetID    string          `json:"targetId"`
		Replacement json.RawMessage `json:"replacement"`
	}
	if json.Unmarshal(line, &entry) != nil || entry.Type != contextEditType || entry.TargetID == "" {
		return contextEdit{}, false
	}
	return contextEdit{Target: entry.TargetID, Replacement: entry.Replacement}, true
}

// applyContextEdits is the transcript the edits leave.
func applyContextEdits(msgs []piMessage, edits map[string]contextEdit) []piMessage {
	if len(edits) == 0 {
		return msgs
	}
	out := make([]piMessage, 0, len(msgs))
	for _, msg := range msgs {
		edit, ok := edits[msg.EntryID]
		if !ok {
			out = append(out, msg)
			continue
		}
		if edit.excluded() {
			continue
		}
		if content := edit.content(); len(content) > 0 {
			msg.Content = content
		}
		out = append(out, msg)
	}
	return out
}

// historyLineMessage is one of pi's message entries, with the time the file
// wrote on the entry itself: the message inside carries none.
func historyLineMessage(line []byte) (piMessage, bool) {
	var msg piMessage
	if len(line) == 0 {
		return msg, false
	}
	var entry struct {
		Type      string          `json:"type"`
		ID        string          `json:"id"`
		Timestamp string          `json:"timestamp"`
		Message   json.RawMessage `json:"message"`
	}
	if json.Unmarshal(line, &entry) != nil || entry.Type != "message" || len(entry.Message) == 0 || json.Unmarshal(entry.Message, &msg) != nil {
		return msg, false
	}
	msg.EntryID = entry.ID
	if msg.Timestamp == 0 {
		if at, err := time.Parse(time.RFC3339Nano, entry.Timestamp); err == nil {
			msg.Timestamp = at.UnixMilli()
		}
	}
	return msg, true
}
