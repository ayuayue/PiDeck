//go:build !js && !android && !ios

package main

// Claude Code's project logs (and Qoder's, which are the same shape with
// its own names). One JSONL line is one transcript entry; the live chain is
// what remains after connecting each entry to its parent, so a rewind's
// abandoned branch is not imported.

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// claudeFamily is what one tool of this shape is called.
type claudeFamily struct {
	key      string
	label    string
	root     func() string
	recursor bool // walk subfolders, or take the top level's files only
	provider string
	model    string
}

// claudeFamiles are the tools whose logs share this shape.
var (
	familyClaude = claudeFamily{key: "claude", label: "Claude Code", recursor: true,
		root: func() string { return importRoot("claude", ".claude", "projects") }, provider: "anthropic", model: "claude-sonnet-4"}
	familyQoder = claudeFamily{key: "qoder", label: "Qoder", recursor: false,
		root: func() string { return importRoot("qoder", ".qoder-cn", "projects") }, provider: "qoder", model: "qoder"}
)

// sourceClaude reads Claude Code's logs.
var sourceClaude = claudeSource(familyClaude)

// sourceQoder reads Qoder's logs.
var sourceQoder = claudeSource(familyQoder)

// claudeSource builds the import source for one tool of this shape.
func claudeSource(f claudeFamily) *importSource {
	return &importSource{
		Key: f.key, Label: f.label, Version: 1,
		Roots: func() []string { return []string{f.root()} },
		Scan: func(root string) ([]importCandidate, error) {
			return scanClaudeFamily(root, f)
		},
		Read: func(path string) (importedSession, error) { return readClaudeFamily(path, f) },
		Sniff: sniffClaudeFamily,
	}
}

// sniffClaudeFamily says whether a file is one of this family's logs.
func sniffClaudeFamily(head []byte) bool {
	sc := bufio.NewScanner(strings.NewReader(string(head)))
	sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
	for i := 0; i < 40 && sc.Scan(); i++ {
		var e struct {
			Type      string `json:"type"`
			SessionID string `json:"sessionId"`
			Cwd       string `json:"cwd"`
			Message   any    `json:"message"`
		}
		line := strings.TrimSpace(sc.Text())
		if line == "" || json.Unmarshal([]byte(line), &e) != nil {
			continue
		}
		if e.Type == "user" && e.SessionID != "" && e.Cwd != "" {
			return true
		}
	}
	return false
}

// claudeLog is one line of a Claude transcript, as much as is read.
type claudeLog struct {
	Type        string          `json:"type"`
	SessionID   string          `json:"sessionId"`
	Cwd         string          `json:"cwd"`
	UUID        string          `json:"uuid"`
	ParentUUID  string          `json:"parentUuid"`
	Timestamp   string          `json:"timestamp"`
	IsSidechain bool            `json:"isSidechain"`
	Subtype     string          `json:"subtype"`
	Message     json.RawMessage `json:"message"`
}

// claudeMessage is the message inside a log line.
type claudeMessage struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content"`
	Model      string          `json:"model"`
	StopReason string          `json:"stop_reason"`
}

// scanClaudeFamily lists the sessions under one root, reading each file's
// head only.
func scanClaudeFamily(root string, f claudeFamily) ([]importCandidate, error) {
	files, err := claudeFiles(root, f.recursor)
	if err != nil {
		return nil, err
	}
	return scanHeads(files, func(path string) (importCandidate, bool) {
		return readClaudeCandidate(path, f)
	}), nil
}

// claudeFiles lists the transcript files of one store, oldest first.
func claudeFiles(root string, recursor bool) ([]string, error) {
	var files []string
	if _, err := os.Stat(root); err != nil {
		return nil, err
	}
	if !recursor {
		entries, err := os.ReadDir(root)
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".jsonl") {
				continue
			}
			files = append(files, filepath.Join(root, e.Name()))
		}
		return files, nil
	}
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(strings.ToLower(d.Name()), ".jsonl") {
			return nil
		}
		files = append(files, path)
		return nil
	})
	return files, nil
}

// readClaudeCandidate reads one file's head for the list.
func readClaudeCandidate(path string, f claudeFamily) (importCandidate, bool) {
	info, err := os.Stat(path)
	if err != nil {
		return importCandidate{}, false
	}
	head, ok := readClaudeHead(path)
	if !ok {
		return importCandidate{}, false
	}
	return importCandidate{Source: f.key, ID: head.id, Path: path, Cwd: head.cwd, Title: head.title,
		Updated: head.last, Size: info.Size(), MTime: info.ModTime(), Count: head.count}, true
}

// claudeHead is what a list row needs from a transcript's head.
type claudeHead struct {
	id    string
	cwd   string
	title string
	first time.Time
	last  time.Time
	count int
}

// claudeHeadBytes is how much of a transcript is read to list it: the
// metadata sits in the first few user lines of every real file.
const claudeHeadBytes = 1 << 20

// readClaudeHead reads a transcript's first bytes for its metadata.
func readClaudeHead(path string) (claudeHead, bool) {
	f, err := os.Open(path)
	if err != nil {
		return claudeHead{}, false
	}
	defer f.Close()
	var head claudeHead
	sc := bufio.NewScanner(io.LimitReader(f, claudeHeadBytes))
	sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var e claudeLog
		if json.Unmarshal([]byte(line), &e) != nil {
			continue
		}
		if when := parseClaudeTime(e.Timestamp); !when.IsZero() {
			if head.first.IsZero() || when.Before(head.first) {
				head.first = when
			}
			if when.After(head.last) {
				head.last = when
			}
		}
		if (e.Type == "user" || e.Type == "assistant") && len(e.Message) > 0 {
			head.count++
		}
		if e.Type != "user" || e.SessionID == "" || e.Cwd == "" {
			continue
		}
		if head.id == "" {
			head.id, head.cwd = e.SessionID, e.Cwd
		}
		if head.title == "" {
			if text := claudeFirstText(e.Message); text != "" {
				head.title = firstLine(text, 60)
			}
		}
	}
	if head.id == "" || head.cwd == "" {
		return claudeHead{}, false
	}
	return head, true
}

// claudeFirstText is the text of a message, when it is the user's own words.
func claudeFirstText(raw json.RawMessage) string {
	var msg claudeMessage
	if json.Unmarshal(raw, &msg) != nil || msg.Role != "user" {
		return ""
	}
	var text string
	if json.Unmarshal(msg.Content, &text) == nil {
		return strings.TrimSpace(text)
	}
	var blocks []map[string]any
	if json.Unmarshal(msg.Content, &blocks) != nil {
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

// parseClaudeTime reads a transcript timestamp.
func parseClaudeTime(v string) time.Time {
	tv := importTime(v)
	if !tv.ok {
		return time.Time{}
	}
	return tv.time
}

// readClaudeFamily converts one transcript into pi's terms.
func readClaudeFamily(path string, f claudeFamily) (importedSession, error) {
	if _, err := os.Stat(path); err != nil {
		return importedSession{}, err
	}
	chain, filtered := claudeLiveChain(path)
	return convertClaude(path, f, chain, filtered)
}

// claudeLiveChain is the set of entries on the path to the transcript's
// tip: a rewind leaves abandoned entries in the file, and they are not part
// of the conversation. A file without uuid links returns false, which keeps
// every entry.
func claudeLiveChain(path string) (map[string]bool, bool) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	parent := map[string]string{}
	tip, anyTip := "", ""
	sc := newImportScanner(f)
	for sc.Scan() {
		var e struct {
			UUID        string `json:"uuid"`
			ParentUUID  string `json:"parentUuid"`
			IsSidechain bool   `json:"isSidechain"`
		}
		if json.Unmarshal(sc.Bytes(), &e) != nil || e.UUID == "" {
			continue
		}
		parent[e.UUID] = e.ParentUUID
		if len(parent) > 1_000_000 {
			return nil, false
		}
		if e.IsSidechain {
			anyTip = e.UUID
		} else {
			tip = e.UUID
		}
	}
	effective := tip
	if effective == "" {
		effective = anyTip
	}
	if effective == "" {
		return nil, false
	}
	chain := map[string]bool{}
	for cur := effective; cur != "" && !chain[cur]; {
		chain[cur] = true
		cur = parent[cur]
	}
	return chain, true
}

// convertClaude walks the transcript and builds the session.
func convertClaude(path string, f claudeFamily, chain map[string]bool, filtered bool) (importedSession, error) {
	fh, err := os.Open(path)
	if err != nil {
		return importedSession{}, err
	}
	defer fh.Close()
	out := importedSession{}
	pending := map[string]bool{}
	var buffered []importBlock
	var bufferedIDs []string
	var bufferedAt time.Time
	var bufferedModel, bufferedStop string
	// flush writes the assistant turn held so far. Consecutive assistant
	// entries are one turn: the source splits a turn at every content
	// block, and pi keeps it whole.
	flush := func() {
		if len(buffered) > 0 {
			out.Messages = append(out.Messages, importMessage{Role: "assistant", Blocks: buffered, Timestamp: bufferedAt,
				Model: bufferedModel, Provider: f.provider, StopReason: importStopReason(bufferedStop, len(bufferedIDs) > 0)})
		}
		pending = map[string]bool{}
		for _, id := range bufferedIDs {
			pending[id] = true
		}
		buffered, bufferedIDs = nil, nil
		bufferedModel, bufferedStop = "", ""
	}
	result := func(r map[string]any, at time.Time) {
		id := asString(r["tool_use_id"])
		if id == "" {
			id = asString(r["toolCallId"])
		}
		name := asString(r["name"])
		if name == "" {
			name = "tool"
		}
		text := importToolOutput(r["content"])
		if strings.TrimSpace(text) == "" {
			text = importToolOutput(r["output"])
		}
		if id != "" && pending[id] {
			delete(pending, id)
			out.Messages = append(out.Messages, importMessage{Role: "toolResult", Text: text, Timestamp: at,
				ToolCallID: id, ToolName: name, IsError: importBool(r["is_error"], r["isError"])})
			return
		}
		if strings.TrimSpace(text) == "" {
			return
		}
		// The call is gone (rewind, or a turn the source cut): keep what the
		// tool said as the user's own words rather than lose it.
		out.Messages = append(out.Messages, importMessage{Role: "user", Timestamp: at, Blocks: []importBlock{{
			Kind: "text", Text: "[" + name + " result, detached from its tool call in the source transcript, kept as text]" + "\n" + text,
		}}})
	}
	sc := newImportScanner(fh)
	for sc.Scan() {
		line := sc.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		var e claudeLog
		if json.Unmarshal(line, &e) != nil {
			continue
		}
		if filtered && e.UUID != "" && !chain[e.UUID] {
			continue
		}
		at := parseClaudeTime(e.Timestamp)
		if out.Updated.Before(at) {
			out.Updated = at
		}
		switch e.Type {
		case "user":
			var msg claudeMessage
			_ = json.Unmarshal(e.Message, &msg)
			results, content := claudeUserParts(msg.Content)
			flush()
			for _, r := range results {
				result(r, at)
			}
			if len(content) == 0 {
				continue
			}
			out.Messages = append(out.Messages, importMessage{Role: "user", Timestamp: at, Blocks: content})
			if out.Title == "" {
				for _, b := range content {
					if b.Kind == "text" && strings.TrimSpace(b.Text) != "" && !strings.HasPrefix(strings.TrimSpace(b.Text), "/") {
						out.Title = firstLine(b.Text, 60)
						break
					}
				}
			}
		case "tool_result":
			// A few exports write the result as its own entry.
			var raw map[string]any
			if json.Unmarshal(line, &raw) != nil {
				continue
			}
			flush()
			result(raw, at)
		case "assistant":
			var msg claudeMessage
			_ = json.Unmarshal(e.Message, &msg)
			if bufferedAt.IsZero() {
				bufferedAt = at
			}
			if msg.Model != "" {
				bufferedModel = msg.Model
			}
			if msg.StopReason != "" {
				bufferedStop = msg.StopReason
			}
			blocks, ids := claudeAssistantBlocks(msg.Content)
			buffered = append(buffered, blocks...)
			bufferedIDs = append(bufferedIDs, ids...)
		}
	}
	flush()
	out.Messages = repairToolResults(out.Messages)
	if out.Cwd == "" {
		out.Cwd = claudeCwd(path)
	}
	return out, sc.Err()
}
// claudeCwd reads a transcript's working folder, from its first line that
// names one.
func claudeCwd(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := newImportScanner(f)
	for sc.Scan() {
		var e claudeLog
		if json.Unmarshal(sc.Bytes(), &e) == nil && e.Cwd != "" {
			return e.Cwd
		}
	}
	return ""
}

// claudeUserParts splits a user message into tool results and content.
func claudeUserParts(raw json.RawMessage) ([]map[string]any, []importBlock) {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		if strings.TrimSpace(text) == "" {
			return nil, nil
		}
		return nil, []importBlock{{Kind: "text", Text: text}}
	}
	var items []any
	if json.Unmarshal(raw, &items) != nil {
		return nil, nil
	}
	var results []map[string]any
	var content []importBlock
	for _, item := range items {
		switch v := item.(type) {
		case string:
			if strings.TrimSpace(v) != "" {
				content = append(content, importBlock{Kind: "text", Text: v})
			}
		case map[string]any:
			block, result := claudeBlock(v)
			if result != nil {
				results = append(results, result)
				continue
			}
			if block != nil {
				content = append(content, *block)
			}
		}
	}
	return results, content
}

// claudeBlock maps one content block of an assistant or user message.
func claudeBlock(v map[string]any) (*importBlock, map[string]any) {
	switch asString(v["type"]) {
	case "text":
		b := importBlock{Kind: "text", Text: asString(v["text"])}
		return &b, nil
	case "thinking":
		b := importBlock{Kind: "thinking", Thinking: asString(v["thinking"])}
		return &b, nil
	case "tool_use":
		b := importBlock{Kind: "toolCall", ID: asString(v["id"]), Name: asString(v["name"]),
			Arguments: importArguments(v["input"])}
		return &b, nil
	case "tool_result":
		return nil, v
	case "image", "input_image":
		label := ""
		for _, key := range []string{"filename", "name", "url"} {
			if s := asString(v[key]); s != "" {
				label = s
				break
			}
		}
		mime := asString(v["media_type"])
		if mime == "" {
			mime = asString(v["mimeType"])
		}
		data := asString(v["data"])
		if data == "" {
			if src := asMap(v["source"]); src != nil {
				data = asString(src["data"])
				if mime == "" {
					mime = asString(src["media_type"])
				}
			}
		}
		if data == "" {
			data = asString(v["url"])
		}
		b := importImageBlock(data, mime, label)
		return &b, nil
	case "file":
		mime := asString(v["mime_type"])
		if !strings.HasPrefix(mime, "image/") {
			return nil, nil
		}
		b := importImageBlock(asString(v["data"]), mime, asString(v["filename"]))
		return &b, nil
	}
	out, err := json.Marshal(v)
	if err != nil {
		return nil, nil
	}
	b := importBlock{Kind: "text", Text: string(out)}
	return &b, nil
}

// claudeAssistantBlocks maps an assistant message and returns the tool
// calls it asked for.
func claudeAssistantBlocks(raw json.RawMessage) ([]importBlock, []string) {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		if strings.TrimSpace(text) == "" {
			return nil, nil
		}
		return []importBlock{{Kind: "text", Text: text}}, nil
	}
	var items []any
	if json.Unmarshal(raw, &items) != nil {
		return nil, nil
	}
	var blocks []importBlock
	var ids []string
	for _, item := range items {
		v, ok := item.(map[string]any)
		if !ok {
			continue
		}
		block, result := claudeBlock(v)
		if result != nil || block == nil {
			continue
		}
		if block.Kind == "toolCall" && block.ID != "" {
			ids = append(ids, block.ID)
		}
		blocks = append(blocks, *block)
	}
	return blocks, ids
}

// importBool reads a flag written as a boolean or a string.
func importBool(values ...any) bool {
	for _, v := range values {
		switch v := v.(type) {
		case bool:
			return v
		case string:
			if strings.EqualFold(v, "true") {
				return true
			}
		}
	}
	return false
}

// newImportScanner reads a JSONL file line by line, with room for the long
// lines tool output makes.
func newImportScanner(r io.Reader) *bufio.Scanner {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 256<<10), 64<<20)
	return sc
}

// scanHeads reads files in parallel and keeps the candidates that parsed.
func scanHeads(files []string, one func(path string) (importCandidate, bool)) []importCandidate {
	out := make([]importCandidate, len(files))
	workers := min(importScanWorkers, len(files))
	queue := make(chan int)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range queue {
				if cand, ok := one(files[i]); ok {
					out[i] = cand
				}
			}
		}()
	}
	for i := range files {
		queue <- i
	}
	close(queue)
	wg.Wait()
	kept := out[:0]
	for _, cand := range out {
		if cand.ID != "" {
			kept = append(kept, cand)
		}
	}
	return kept
}
