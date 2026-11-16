//go:build !js && !android && !ios

package main

// MiniMax's CLI keeps one folder per session under a date tree, with the
// transcript in messages.jsonl and the folder a call ran in inside the
// request log.

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// sourceMinimax reads MiniMax's session folders.
var sourceMinimax = &importSource{
	Key: "minimax", Label: "MiniMax", Version: 1,
	Roots: func() []string { return []string{importRoot("minimax", ".minimax", "v2", "sessions")} },
	Scan:  scanMinimax,
	Read:  readMinimax,
	Sniff: func(head []byte) bool { return false },
}

// minimaxWorkdir finds the folder a request ran in, in the request log's
// system prompt.
var minimaxWorkdir = regexp.MustCompile(`working directory:\s*([^\r\n"']+)`)

// scanMinimax lists MiniMax's sessions: folders under a date tree, named
// after the session.
func scanMinimax(root string) ([]importCandidate, error) {
	var out []importCandidate
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return nil
		}
		depth := len(strings.Split(filepath.ToSlash(rel), "/"))
		if !d.IsDir() {
			return nil
		}
		if depth > 4 {
			return filepath.SkipDir
		}
		if !strings.Contains(d.Name(), "-session_") {
			return nil
		}
		cand, ok := readMinimaxCandidate(path)
		if ok {
			out = append(out, cand)
		}
		return filepath.SkipDir
	})
	return out, nil
}

// minimaxManifest is a session's manifest.json.
type minimaxManifest struct {
	SessionID    string `json:"sessionId"`
	CreatedAtMS  int64  `json:"createdAtMs"`
	UpdatedAtMS  int64  `json:"updatedAtMs"`
	MessageCount int    `json:"messageCount"`
}

// readMinimaxCandidate reads one session folder's files for the list.
func readMinimaxCandidate(dir string) (importCandidate, bool) {
	messages := filepath.Join(dir, "messages.jsonl")
	info, err := os.Stat(messages)
	if err != nil || info.Size() == 0 {
		return importCandidate{}, false
	}
	var manifest minimaxManifest
	if raw, err := os.ReadFile(filepath.Join(dir, "manifest.json")); err == nil && len(raw) < 4<<20 {
		_ = json.Unmarshal(raw, &manifest)
	}
	cand := importCandidate{Source: "minimax", Path: messages, ID: manifest.SessionID,
		Size: info.Size(), MTime: info.ModTime(), Count: manifest.MessageCount}
	if cand.ID == "" {
		cand.ID = filepath.Base(dir)
	}
	cand.Cwd = readMinimaxWorkdir(filepath.Join(dir, "llm-call.json"))
	if manifest.UpdatedAtMS > 0 {
		cand.Updated = time.UnixMilli(manifest.UpdatedAtMS)
	}
	if cand.Updated.IsZero() {
		cand.Updated = info.ModTime()
	}
	cand.Title = readMinimaxTitle(messages)
	return cand, true
}

// readMinimaxWorkdir reads the folder a session's calls ran in.
func readMinimaxWorkdir(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, 4<<20))
	if err != nil {
		return ""
	}
	m := minimaxWorkdir.FindSubmatch(raw)
	if m == nil {
		return ""
	}
	dir := strings.TrimSpace(string(m[1]))
	// The prompt is JSON-escaped text: a literal backslash-n ends the line.
	if i := strings.Index(dir, "\\n"); i >= 0 {
		dir = dir[:i]
	}
	if i := strings.Index(dir, "\\r"); i >= 0 {
		dir = dir[:i]
	}
	dir = strings.TrimSpace(dir)
	if !strings.HasPrefix(dir, "/") && !(len(dir) > 2 && dir[1] == ':') {
		return ""
	}
	return dir
}

// readMinimaxTitle reads the first thing the user said.
func readMinimaxTitle(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(io.LimitReader(f, 256<<10))
	sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
	for i := 0; i < 8 && sc.Scan(); i++ {
		var line struct {
			Message struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(sc.Bytes(), &line) != nil || line.Message.Role != "user" {
			continue
		}
		if text := stripInjectedReminder(minimaxText(line.Message.Content)); text != "" {
			return firstLine(text, 60)
		}
	}
	return ""
}

// minimaxText joins a content's text blocks.
func minimaxText(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var blocks []map[string]any
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	var parts []string
	for _, b := range blocks {
		if asString(b["type"]) == "text" {
			if t := strings.TrimSpace(asString(b["text"])); t != "" {
				parts = append(parts, t)
			}
		}
	}
	return strings.Join(parts, "\n")
}

// readMinimax converts one session's messages into pi's terms.
func readMinimax(path string) (importedSession, error) {
	f, err := os.Open(path)
	if err != nil {
		return importedSession{}, err
	}
	defer f.Close()
	out := importedSession{}
	if dir := filepath.Dir(path); dir != "" {
		out.Cwd = readMinimaxWorkdir(filepath.Join(dir, "llm-call.json"))
	}
	sc := newImportScanner(f)
	for sc.Scan() {
		line := sc.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		var rec struct {
			MessageID string `json:"message_id"`
			Message   struct {
				Role      string          `json:"role"`
				Content   json.RawMessage `json:"content"`
				Timestamp any             `json:"timestamp"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &rec) != nil {
			continue
		}
		role := rec.Message.Role
		if role != "user" && role != "assistant" {
			continue
		}
		at := importTime(rec.Message.Timestamp).time
		if out.Updated.Before(at) {
			out.Updated = at
		}
		blocks, results := minimaxBlocks(rec.Message.Content)
		for _, r := range results {
			out.Messages = append(out.Messages, r)
		}
		if len(blocks) == 0 {
			continue
		}
		if role == "user" && len(results) > 0 && len(blocks) == 0 {
			continue
		}
		out.Messages = append(out.Messages, importMessage{Role: role, Timestamp: at, Blocks: blocks,
			Provider: "minimax", Model: "minimax-import",
			StopReason: importStopReason("", hasToolCall(blocks))})
		if role == "user" && out.Title == "" {
			for _, b := range blocks {
				if b.Kind == "text" {
					if text := stripInjectedReminder(b.Text); text != "" {
						out.Title = firstLine(text, 60)
						break
					}
				}
			}
		}
	}
	out.Messages = repairToolResults(out.Messages)
	return out, sc.Err()
}

// minimaxBlocks maps a MiniMax content list, pulling tool results out of it.
func minimaxBlocks(raw json.RawMessage) ([]importBlock, []importMessage) {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		if strings.TrimSpace(text) == "" {
			return nil, nil
		}
		return []importBlock{{Kind: "text", Text: text}}, nil
	}
	var items []map[string]any
	if json.Unmarshal(raw, &items) != nil {
		return nil, nil
	}
	var blocks []importBlock
	var results []importMessage
	for _, b := range items {
		switch asString(b["type"]) {
		case "text":
			if text := stripInjectedReminder(asString(b["text"])); text != "" {
				blocks = append(blocks, importBlock{Kind: "text", Text: text})
			}
		case "thinking":
			blocks = append(blocks, importBlock{Kind: "thinking", Thinking: asString(b["thinking"])})
		case "tool_use":
			blocks = append(blocks, importBlock{Kind: "toolCall", ID: asString(b["id"]), Name: asString(b["name"]),
				Arguments: importArguments(b["input"])})
		case "tool_result":
			id := firstNonEmpty(asString(b["tool_use_id"]), asString(b["id"]))
			name := orDefault(asString(b["name"]), "tool")
			results = append(results, importMessage{Role: "toolResult", ToolCallID: id, ToolName: name,
				Text: importToolOutput(b["content"]), IsError: importBool(b["is_error"])})
		default:
			if out, err := json.Marshal(b); err == nil {
				blocks = append(blocks, importBlock{Kind: "text", Text: string(out)})
			}
		}
	}
	return blocks, results
}

// hasToolCall reports whether blocks ask for a tool.
func hasToolCall(blocks []importBlock) bool {
	for _, b := range blocks {
		if b.Kind == "toolCall" {
			return true
		}
	}
	return false
}
