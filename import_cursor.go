//go:build !js && !android && !ios

package main

// Cursor's agent transcripts: one JSONL per conversation under
// `~/.cursor/projects/<project slug>/agent-transcripts/`. Cursor writes the
// time of a prompt inside the prompt itself, as a `<timestamp>` tag.

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

// sourceCursor reads Cursor's agent transcripts.
var sourceCursor = &importSource{
	Key: "cursor", Label: "Cursor", Version: 1,
	Roots: func() []string { return []string{importRoot("cursor", ".cursor", "projects")} },
	Scan:  scanCursor,
	Read:  readCursor,
	Sniff: func(head []byte) bool { return false }, // one file is not a session
}

// cursorStamp finds the time Cursor writes into a prompt.
var cursorStamp = regexp.MustCompile(`(?s)<timestamp>(.*?)</timestamp>`)

// cursorQuery finds the user's own words inside a prompt.
var cursorQuery = regexp.MustCompile(`(?s)<user_query>(.*?)</user_query>`)

// cursorUserText keeps the user's query and drops Cursor's wrappers.
func cursorUserText(text string) (string, time.Time) {
	var at time.Time
	if m := cursorStamp.FindStringSubmatch(text); m != nil {
		at = cursorStampTime(m[1])
		text = cursorStamp.ReplaceAllString(text, "")
	}
	if m := cursorQuery.FindStringSubmatch(text); m != nil {
		var parts []string
		for _, one := range cursorQuery.FindAllStringSubmatch(text, -1) {
			if q := strings.TrimSpace(one[1]); q != "" {
				parts = append(parts, q)
			}
		}
		text = strings.Join(parts, "\n\n")
	}
	return strings.TrimSpace(text), at
}

// cursorStampTime reads `Monday, June 2, 2025, 10:20 AM (UTC+8)`.
func cursorStampTime(raw string) time.Time {
	raw = strings.TrimSpace(raw)
	loc := time.UTC
	if i := strings.LastIndex(raw, "(UTC"); i >= 0 {
		zone := strings.TrimSuffix(strings.TrimPrefix(raw[i:], "(UTC"), ")")
		zone = strings.TrimPrefix(zone, "UTC")
		if minutes, err := time.ParseDuration(strings.TrimPrefix(zone, "+") + "h"); err == nil && !strings.HasPrefix(zone, "-") {
			loc = time.FixedZone("", int(minutes.Seconds()))
		} else if minutes, err := time.ParseDuration(zone + "h"); err == nil {
			loc = time.FixedZone("", int(minutes.Seconds()))
		}
		raw = strings.TrimSpace(raw[:i])
	}
	for _, layout := range []string{
		"Monday, January 2, 2006, 3:04 PM",
		"Monday, Jan 2, 2006, 3:04 PM",
		"Monday, January 2, 2006, 15:04",
		"2006-01-02T15:04:05",
	} {
		if t, err := time.ParseInLocation(layout, raw, loc); err == nil {
			return t
		}
	}
	return time.Time{}
}

// cursorSources lists one projects folder's transcripts as (path, cwd).
func cursorFiles(root string) []struct {
	path string
	cwd  string
} {
	var out []struct {
		path string
		cwd  string
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	for _, project := range entries {
		if !project.IsDir() {
			continue
		}
		dir := filepath.Join(root, project.Name())
		cwd := familySlugPath(project.Name())
		// Both layouts: agent-transcripts/*.jsonl and
		// agent-transcripts/<id>/<id>.jsonl.
		files := familyFiles(dir)
		for _, path := range files {
			if !strings.Contains(filepath.ToSlash(path), "/agent-transcripts/") {
				continue
			}
			out = append(out, struct {
				path string
				cwd  string
			}{path: path, cwd: cwd})
		}
	}
	return out
}

// scanCursor lists Cursor's transcripts, reading each head.
func scanCursor(root string) ([]importCandidate, error) {
	var files []string
	for _, f := range cursorFiles(root) {
		files = append(files, f.path)
	}
	cwds := map[string]string{}
	for _, f := range cursorFiles(root) {
		cwds[f.path] = f.cwd
	}
	return scanHeads(files, func(path string) (importCandidate, bool) {
		return readCursorCandidate(path, cwds[path])
	}), nil
}

// readCursorCandidate reads one transcript's head for the list.
func readCursorCandidate(path, cwd string) (importCandidate, bool) {
	info, err := os.Stat(path)
	if err != nil {
		return importCandidate{}, false
	}
	f, err := os.Open(path)
	if err != nil {
		return importCandidate{}, false
	}
	defer f.Close()
	var cand importCandidate
	sc := bufio.NewScanner(io.LimitReader(f, 1<<20))
	sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var rec map[string]any
		if json.Unmarshal([]byte(line), &rec) != nil {
			continue
		}
		if asString(rec["type"]) == "turn_ended" {
			continue
		}
		role := cursorRole(rec)
		if role != "user" && role != "assistant" {
			continue
		}
		cand.Count++
		text, at := cursorRecordText(rec)
		if !at.IsZero() {
			if cand.Updated.Before(at) {
				cand.Updated = at
			}
		}
		if role == "user" && cand.Title == "" {
			cand.Title = firstLine(text, 60)
		}
	}
	if cand.Count == 0 {
		return importCandidate{}, false
	}
	cand.Source = "cursor"
	cand.ID = strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	cand.Path = path
	cand.Cwd = cwd
	cand.Size, cand.MTime = info.Size(), info.ModTime()
	if cand.Updated.IsZero() {
		cand.Updated = info.ModTime()
	}
	return cand, true
}

// cursorRole reads a record's role, from either place Cursor writes it.
func cursorRole(rec map[string]any) string {
	if role := asString(rec["role"]); role != "" {
		return role
	}
	if msg := asMap(rec["message"]); msg != nil {
		return asString(msg["role"])
	}
	return ""
}

// cursorRecordText is a record's text, for the list.
func cursorRecordText(rec map[string]any) (string, time.Time) {
	content := rec["content"]
	if msg := asMap(rec["message"]); msg != nil && msg["content"] != nil {
		content = msg["content"]
	}
	var texts []string
	switch v := content.(type) {
	case string:
		texts = append(texts, v)
	case []any:
		for _, item := range v {
			switch b := item.(type) {
			case string:
				texts = append(texts, b)
			case map[string]any:
				if asString(b["type"]) == "text" {
					texts = append(texts, asString(b["text"]))
				}
			}
		}
	}
	if len(texts) == 0 {
		return "", time.Time{}
	}
	return cursorUserText(strings.Join(texts, "\n"))
}

// readCursor converts one transcript into pi's terms.
func readCursor(path string) (importedSession, error) {
	f, err := os.Open(path)
	if err != nil {
		return importedSession{}, err
	}
	defer f.Close()
	out := importedSession{}
	if cwd := cursorCwdOf(path); cwd != "" {
		out.Cwd = cwd
	}
	sc := newImportScanner(f)
	for sc.Scan() {
		line := sc.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		var rec map[string]any
		if json.Unmarshal(line, &rec) != nil {
			continue
		}
		at := cursorRecordTime(rec)
		if out.Updated.Before(at) {
			out.Updated = at
		}
		if asString(rec["type"]) == "turn_ended" {
			continue
		}
		if asString(rec["type"]) == "tool_result" {
			cursorToolResult(rec, at, &out)
			continue
		}
		role := cursorRole(rec)
		if role != "user" && role != "assistant" {
			continue
		}
		content := rec["content"]
		if msg := asMap(rec["message"]); msg != nil && msg["content"] != nil {
			content = msg["content"]
		}
		blocks, calls := cursorBlocks(content, role)
		if role == "user" {
			var texts []string
			for _, b := range blocks {
				if b.Kind == "text" {
					texts = append(texts, b.Text)
				}
			}
			if len(texts) > 0 {
				text, when := cursorUserText(strings.Join(texts, "\n"))
				if when.IsZero() {
					when = at
				}
				if out.Updated.Before(when) {
					out.Updated = when
				}
				if text != "" {
					out.Messages = append(out.Messages, importMessage{Role: "user", Timestamp: when,
						Blocks: []importBlock{{Kind: "text", Text: text}}})
					if out.Title == "" {
						out.Title = firstLine(text, 60)
					}
				}
			}
			continue
		}
		if len(blocks) == 0 {
			continue
		}
		out.Messages = append(out.Messages, importMessage{Role: "assistant", Timestamp: at, Blocks: blocks,
			Provider: "cursor", Model: "cursor-import", StopReason: importStopReason("", len(calls) > 0)})
	}
	out.Messages = repairToolResults(out.Messages)
	return out, sc.Err()
}

// cursorRecordTime is a record's own timestamp, when it has one.
func cursorRecordTime(rec map[string]any) time.Time {
	for _, key := range []string{"timestamp", "created_at", "createdAt"} {
		if tv := importTime(rec[key]); tv.ok {
			return tv.time
		}
	}
	return time.Time{}
}

// cursorToolResult writes one tool result, keeping its text as the user's
// words when its call is gone.
func cursorToolResult(rec map[string]any, at time.Time, out *importedSession) {
	id := asString(rec["toolCallId"])
	if id == "" {
		id = asString(rec["tool_use_id"])
	}
	name := asString(rec["toolName"])
	if name == "" {
		name = asString(rec["name"])
	}
	text := importToolOutput(rec["content"])
	if strings.TrimSpace(text) == "" {
		text = importToolOutput(rec["output"])
	}
	if id == "" && strings.TrimSpace(text) == "" {
		return
	}
	out.Messages = append(out.Messages, importMessage{Role: "toolResult", Text: text, Timestamp: at,
		ToolCallID: id, ToolName: orDefault(name, "tool"), IsError: importBool(rec["is_error"], rec["isError"])})
}

// cursorBlocks maps a record's content and returns its tool calls.
func cursorBlocks(content any, role string) ([]importBlock, []importToolCall) {
	var text string
	if json.Unmarshal(mustJSON(content), &text) == nil {
		if strings.TrimSpace(text) == "" {
			return nil, nil
		}
		return []importBlock{{Kind: "text", Text: text}}, nil
	}
	var items []any
	if json.Unmarshal(mustJSON(content), &items) != nil {
		return nil, nil
	}
	var blocks []importBlock
	var calls []importToolCall
	for _, item := range items {
		b := asMap(item)
		if b == nil {
			continue
		}
		switch asString(b["type"]) {
		case "text":
			if t := asString(b["text"]); t != "" {
				blocks = append(blocks, importBlock{Kind: "text", Text: t})
			}
		case "thinking", "reasoning":
			blocks = append(blocks, importBlock{Kind: "thinking", Thinking: asString(b["thinking"])})
		case "tool_use":
			call := importToolCall{ID: asString(b["id"]), Name: asString(b["name"])}
			if call.ID == "" {
				call.ID = importToken("cursor-" + call.Name)
			}
			blocks = append(blocks, importBlock{Kind: "toolCall", ID: call.ID, Name: call.Name,
				Arguments: importArguments(b["input"])})
			calls = append(calls, call)
		case "image", "input_image":
			blocks = append(blocks, importImageBlock(asString(b["data"]), asString(b["mimeType"]), asString(b["name"])))
		case "tool_result":
			// Results travel in their own records.
		default:
			if out, err := json.Marshal(b); err == nil {
				blocks = append(blocks, importBlock{Kind: "text", Text: string(out)})
			}
		}
	}
	return blocks, calls
}

// cursorCwdOf reads a transcript's project folder from its path: the
// folder under projects is the project's slug.
func cursorCwdOf(path string) string {
	parts := strings.Split(filepath.ToSlash(path), "/")
	for i := len(parts) - 1; i > 0; i-- {
		if parts[i-1] == "projects" {
			return familySlugPath(parts[i])
		}
	}
	return ""
}

// mustJSON passes a value through JSON, so the same decoder reads any shape.
func mustJSON(v any) []byte {
	if raw, ok := v.(json.RawMessage); ok {
		return raw
	}
	out, _ := json.Marshal(v)
	if out == nil {
		return []byte("null")
	}
	return out
}
