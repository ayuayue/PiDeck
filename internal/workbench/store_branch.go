//go:build !js && !android && !ios

package workbench

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"time"

	"example.com/pideck-v2/internal/apptext"
)

type branchPoint struct {
	entryID string
	ordinal int
	text    string
}

type branchEntry struct {
	ID, ParentID string
	Line         int
	User         bool
}

func (s *store) forkSession(src, id string, ordinal int, title string) (sessionMeta, string, error) {
	meta, prompt, err := s.branchSession(src, id, branchPoint{ordinal: ordinal}, title)
	return meta, prompt.text(), err
}

// branchSession copies the selected prompt's ancestors to a new pi file.
// The first pass indexes the graph; the second streams only the chosen
// entries. Other branches and descendants of the prompt never enter the fork.
func (s *store) branchSession(src, id string, point branchPoint, title string) (sessionMeta, piMessage, error) {
	head, entries, err := readBranchEntries(src)
	if err != nil {
		return sessionMeta{}, piMessage{}, err
	}
	var path []branchEntry
	seen := make(map[string]bool)
	byID := make(map[string]branchEntry, len(entries))
	for _, entry := range entries {
		byID[entry.ID] = entry
	}
	for id := entries[len(entries)-1].ID; id != ""; {
		if seen[id] {
			return sessionMeta{}, piMessage{}, errors.New(apptext.T("不是有效的 pi 会话文件"))
		}
		seen[id] = true
		entry, ok := byID[id]
		if !ok {
			return sessionMeta{}, piMessage{}, errors.New(apptext.T("不是有效的 pi 会话文件"))
		}
		path = append(path, entry)
		id = entry.ParentID
	}
	slices.Reverse(path)
	ordinal, target := 0, -1
	for i, entry := range path {
		if !entry.User {
			continue
		}
		if (point.entryID != "" && entry.ID == point.entryID) || (point.entryID == "" && ordinal == point.ordinal) {
			target = i
			break
		}
		ordinal++
	}
	if target < 0 {
		return sessionMeta{}, piMessage{}, errors.New(apptext.T("找不到要分叉的那一轮"))
	}
	return s.writeBranch(src, id, title, head, path[:target], path[target], point.text)
}

func readBranchEntries(src string) (map[string]any, []branchEntry, error) {
	var head map[string]any
	var entries []branchEntry
	lineNumber := 0
	seenIDs := make(map[string]bool)
	_, err := readTail(src, 0, func(line []byte) error {
		lineNumber++
		if lineNumber == 1 {
			if json.Unmarshal(line, &head) != nil || head["type"] != "session" {
				return errors.New(apptext.T("不是有效的 pi 会话文件"))
			}
			return nil
		}
		if len(bytes.TrimSpace(line)) == 0 {
			return nil
		}
		var rec struct {
			ID      string          `json:"id"`
			Type    string          `json:"type"`
			Parent  json.RawMessage `json:"parentId"`
			Message struct {
				Role string `json:"role"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &rec) != nil || rec.Type == "" {
			return errors.New(apptext.T("不是有效的 pi 会话文件"))
		}
		id := rec.ID
		if id == "" { // old imported entries can omit their graph fields
			id = fmt.Sprintf("@line%d", lineNumber)
		}
		if seenIDs[id] {
			return errors.New(apptext.T("不是有效的 pi 会话文件"))
		}
		seenIDs[id] = true
		parent := ""
		if len(rec.Parent) == 0 && len(entries) > 0 {
			parent = entries[len(entries)-1].ID
		} else if len(rec.Parent) > 0 && json.Unmarshal(rec.Parent, &parent) != nil {
			return errors.New(apptext.T("不是有效的 pi 会话文件"))
		}
		entries = append(entries, branchEntry{id, parent, lineNumber, rec.Type == "message" && rec.Message.Role == "user"})
		return nil
	})
	if err == nil && len(entries) == 0 {
		err = errors.New(apptext.T("找不到要分叉的那一轮"))
	}
	return head, entries, err
}

func (s *store) writeBranch(src, id, title string, head map[string]any, kept []branchEntry, target branchEntry, expected string) (sessionMeta, piMessage, error) {
	var prompt piMessage
	cwd, _ := head["cwd"].(string)
	if cwd == "" || !filepath.IsLocal(id) || filepath.Base(id) != id {
		return sessionMeta{}, prompt, errors.New(apptext.T("不是有效的 pi 会话文件"))
	}
	now := time.Now().UTC()
	head["id"], head["timestamp"] = id, now.Format(time.RFC3339Nano)
	dir := filepath.Join(s.sessions, encodeCwd(filepath.Clean(cwd)))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return sessionMeta{}, prompt, err
	}
	file, err := os.CreateTemp(dir, ".branch-*")
	if err != nil {
		return sessionMeta{}, prompt, err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	w := bufio.NewWriter(file)
	enc := json.NewEncoder(w)
	if err := enc.Encode(head); err != nil {
		return sessionMeta{}, prompt, err
	}
	lineNumber, next := 0, 0
	var parent any
	found := false
	_, err = readTail(src, 0, func(line []byte) error {
		lineNumber++
		if lineNumber == target.Line {
			var rec struct {
				Message piMessage `json:"message"`
			}
			if json.Unmarshal(line, &rec) != nil || rec.Message.Role != "user" || (expected != "" && rec.Message.text() != expected) {
				return errors.New(apptext.T("找不到要分叉的那一轮"))
			}
			prompt, found = rec.Message, true
			return errStopTail
		}
		if next < len(kept) && lineNumber == kept[next].Line {
			var entry map[string]json.RawMessage
			if err := json.Unmarshal(line, &entry); err != nil {
				return err
			}
			entryID := kept[next].ID
			if len(entry["id"]) == 0 {
				entryID = newSessionID()[:8]
				entry["id"], _ = json.Marshal(entryID)
			}
			entry["parentId"], _ = json.Marshal(parent)
			parent = entryID
			next++
			return enc.Encode(entry)
		}
		return nil
	})
	if err != nil && !errors.Is(err, errStopTail) {
		return sessionMeta{}, prompt, err
	}
	if !found || next != len(kept) {
		return sessionMeta{}, prompt, errors.New(apptext.T("找不到要分叉的那一轮"))
	}
	if title != "" {
		if err := enc.Encode(map[string]any{"type": "session_info", "id": newSessionID()[:8], "parentId": parent, "name": title, "timestamp": now.Format(time.RFC3339Nano)}); err != nil {
			return sessionMeta{}, prompt, err
		}
	}
	if err := errors.Join(w.Flush(), file.Close()); err != nil {
		return sessionMeta{}, prompt, err
	}
	dst := filepath.Join(dir, now.Format("2006-01-02T15-04-05-000Z")+"_"+id+".jsonl")
	if err := os.Rename(file.Name(), dst); err != nil {
		return sessionMeta{}, prompt, err
	}
	meta, ok := s.readMeta(dst, nil)
	if !ok {
		return sessionMeta{}, prompt, errors.New(apptext.T("分叉后无法读取该会话"))
	}
	return meta, prompt, nil
}
