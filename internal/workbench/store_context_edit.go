//go:build !js && !android && !ios

package workbench

// Deleting a turn is a pi-native append, not a rewrite: a context_edit
// record takes the entries out of the model's context while the lines
// themselves stay in the file, so tokens already spent and the original
// transcript are still there to look at.
//
// The record is pi's own (docs/session-format.md):
//
//	{"type":"context_edit","id":…,"parentId":…,"timestamp":…,"targetId":…,"replacement":null}
//
// parentId must be the leaf of the active branch — a record hanging off
// anything else is a side branch pi never walks — so several edits are
// chained one after another.

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"time"

	"example.com/pideck/internal/apptext"
)

// contextEdit is one record's effect on an entry.
type contextEdit struct {
	// Target is the entry the record speaks about.
	Target string
	// Replacement is nil when the entry leaves the context, and the content
	// that stands in for it when it is rewritten.
	Replacement json.RawMessage
}

// contextEditType is pi's record for a message moved out of, or rewritten
// in, the model's context.
const contextEditType = "context_edit"

// excluded reports whether the entry left the model's context.
func (c contextEdit) excluded() bool {
	return len(c.Replacement) == 0 || bytes.Equal(bytes.TrimSpace(c.Replacement), []byte("null"))
}

// content is what stands in for the entry when it was rewritten.
func (c contextEdit) content() json.RawMessage {
	var body struct {
		Content json.RawMessage `json:"content"`
	}
	if c.excluded() || json.Unmarshal(c.Replacement, &body) != nil {
		return nil
	}
	return body.Content
}

// turnEntryIDs lists the entries of the turn whose user message is targetID:
// that message and everything up to the next turn's. The ids come from the
// file, so a turn pi wrote with four assistant messages is deleted whole.
func (s *store) turnEntryIDs(file, targetID string) ([]string, error) {
	if targetID == "" {
		return nil, errors.New(apptext.T("找不到要删除的那一轮"))
	}
	var ids []string
	found, done := false, false
	_, err := readTail(file, 0, func(line []byte) error {
		if done || len(bytes.TrimSpace(line)) == 0 {
			return nil
		}
		var entry struct {
			Type    string `json:"type"`
			ID      string `json:"id"`
			Message struct {
				Role string `json:"role"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &entry) != nil || entry.ID == "" {
			return nil
		}
		user := entry.Type == "message" && entry.Message.Role == "user"
		switch {
		case !found:
			if entry.ID == targetID {
				found = true
				ids = append(ids, entry.ID)
			}
		case user:
			done = true
		case entry.Type == "message":
			ids = append(ids, entry.ID)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, errors.New(apptext.T("找不到要删除的那一轮"))
	}
	return ids, nil
}

// appendContextEdits appends one record per target, chained on the branch's
// leaf so pi collects them all.
func (s *store) appendContextEdits(file string, targets []string) error {
	if len(targets) == 0 {
		return errors.New(apptext.T("找不到要删除的那一轮"))
	}
	leaf, tail, err := lastEntry(file)
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	if tail != '\n' && tail != 0 {
		buf.WriteByte('\n')
	}
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	for _, target := range targets {
		record := map[string]any{
			"type": contextEditType, "id": newSessionID(), "parentId": leaf,
			"timestamp": stamp, "targetId": target, "replacement": nil,
		}
		line, err := json.Marshal(record)
		if err != nil {
			return err
		}
		buf.Write(line)
		buf.WriteByte('\n')
		leaf = record["id"].(string)
	}
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(buf.Bytes())
	return errors.Join(err, f.Close())
}

// lastEntry is the id of the file's last record, which is the branch's leaf,
// and the byte the file ends with.
func lastEntry(file string) (string, byte, error) {
	f, err := os.Open(file)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", 0, err
	}
	size := info.Size()
	if size == 0 {
		return "", 0, errors.New(apptext.T("不是有效的 pi 会话文件"))
	}
	const window = 128 << 10
	start := max(0, size-window)
	raw := make([]byte, size-start)
	if _, err := f.ReadAt(raw, start); err != nil && len(raw) == 0 {
		return "", 0, err
	}
	end := len(raw)
	for end > 0 && (raw[end-1] == '\n' || raw[end-1] == '\r') {
		end--
	}
	begin := bytes.LastIndexByte(raw[:end], '\n') + 1
	var entry struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(raw[begin:end], &entry) != nil || entry.ID == "" {
		return "", 0, errors.New(apptext.T("不是有效的 pi 会话文件"))
	}
	return entry.ID, raw[len(raw)-1], nil
}
