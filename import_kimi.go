//go:build !js && !android && !ios

package main

// Kimi reads two stores. Kimi Code keeps a session index and one folder per
// conversation; Kimi Work (the desktop app) keeps the same wire format under
// a share folder, with the assistant's turn spread across step events.

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// sourceKimi reads Kimi Code's sessions.
var sourceKimi = &importSource{
	Key: "kimi", Label: "Kimi Code", Version: 1,
	Roots: func() []string { return []string{importRoot("kimi", ".kimi-code")} },
	Scan:  scanKimi,
	Read:  readKimi,
	Sniff: func(head []byte) bool { return false },
}

// sourceKimiWork reads Kimi Work's shared conversations.
var sourceKimiWork = &importSource{
	Key: "kimiwork", Label: "Kimi Work", Version: 1,
	Roots: kimiWorkRoots,
	Scan:  scanKimiWork,
	Read:  readKimiWork,
	Sniff: func(head []byte) bool { return false },
}

// kimiIndex is one line of Kimi Code's session index.
type kimiIndex struct {
	SessionID  string `json:"sessionId"`
	SessionDir string `json:"sessionDir"`
	WorkDir    string `json:"workDir"`
}

// kimiState is what a conversation's state.json says.
type kimiState struct {
	ID         string `json:"id"`
	Cwd        string `json:"cwd"`
	WorkDir    string `json:"workDir"`
	Title      string `json:"title"`
	LastPrompt string `json:"lastPrompt"`
	CreatedAt  string `json:"createdAt"`
	UpdatedAt  string `json:"updatedAt"`
}

// scanKimi lists Kimi Code's sessions from its index.
func scanKimi(root string) ([]importCandidate, error) {
	f, err := os.Open(filepath.Join(root, "session_index.jsonl"))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []importCandidate
	sc := bufio.NewScanner(io.LimitReader(f, 4<<20))
	sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
	for sc.Scan() {
		var entry kimiIndex
		if json.Unmarshal(sc.Bytes(), &entry) != nil || entry.SessionDir == "" {
			continue
		}
		wire := filepath.Join(entry.SessionDir, "agents", "main", "wire.jsonl")
		info, err := os.Stat(wire)
		if err != nil {
			continue
		}
		state := readKimiState(filepath.Join(entry.SessionDir, "state.json"))
		cand := importCandidate{Source: "kimi", Path: wire, Size: info.Size(), MTime: info.ModTime(),
			ID: orDefault(state.ID, entry.SessionID), Cwd: orDefault(state.Cwd, orDefault(state.WorkDir, entry.WorkDir))}
		elseTitle(&cand, state)
		if at := kimiStateTime(state); !at.IsZero() {
			cand.Updated = at
		}
		if cand.ID == "" {
			cand.ID = filepath.Base(entry.SessionDir)
		}
		if cand.Updated.IsZero() {
			cand.Updated = info.ModTime()
		}
		out = append(out, cand)
	}
	return out, nil
}

// readKimiState reads a conversation's state.json, as much as is read.
func readKimiState(path string) kimiState {
	var state kimiState
	f, err := os.Open(path)
	if err != nil {
		return state
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, 256<<10))
	if err != nil {
		return state
	}
	_ = json.Unmarshal(raw, &state)
	return state
}

// elseTitle puts a state's name on a row.
func elseTitle(cand *importCandidate, state kimiState) {
	cand.Title = importTitle(state.Title)
	if cand.Title == "" {
		cand.Title = importTitle(state.LastPrompt)
	}
}

// kimiStateTime is when a conversation was last used.
func kimiStateTime(state kimiState) time.Time {
	for _, key := range []string{state.UpdatedAt, state.CreatedAt} {
		if tv := importTime(key); tv.ok {
			return tv.time
		}
	}
	return time.Time{}
}

// kimiWorkRoots finds where Kimi Work shares its conversations: a settings
// file names a folder, and the app's default sits beside it.
func kimiWorkRoots() []string {
	var roots []string
	if dir, err := os.UserConfigDir(); err == nil {
		if raw, err := os.ReadFile(filepath.Join(dir, "kimi-desktop", "daimon-storage.json")); err == nil {
			var cfg struct {
				ShareDir string `json:"shareDir"`
			}
			if json.Unmarshal(raw, &cfg) == nil && cfg.ShareDir != "" {
				roots = append(roots, cfg.ShareDir)
			}
		}
		roots = append(roots, filepath.Join(dir, "kimi-desktop", "daimon-share"))
	}
	return roots
}

// scanKimiWork lists Kimi Work's conversations under a share folder.
func scanKimiWork(share string) ([]importCandidate, error) {
	sessions := filepath.Join(share, "daimon", "runtime", "kimi-code", "home", "sessions")
	var out []importCandidate
	_ = filepath.WalkDir(sessions, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() || d.Name() != "wire.jsonl" || !strings.HasSuffix(filepath.ToSlash(path), "/agents/main/wire.jsonl") {
			return nil
		}
		info, err := os.Stat(path)
		if err != nil {
			return nil
		}
		conv := filepath.Dir(filepath.Dir(filepath.Dir(path)))
		state := readKimiState(filepath.Join(conv, "state.json"))
		cand := importCandidate{Source: "kimiwork", Path: path, ID: filepath.Base(conv),
			Size: info.Size(), MTime: info.ModTime()}
		cand.Cwd = firstNonEmpty(state.WorkDir, state.Cwd, kimiWorkMarkerDir(sessions, path))
		elseTitle(&cand, state)
		if at := kimiStateTime(state); !at.IsZero() {
			cand.Updated = at
		} else {
			cand.Updated = info.ModTime()
		}
		out = append(out, cand)
		return nil
	})
	return out, nil
}

// kimiWorkMarkerDir reads the folder a wd_ marker names: the marker keeps
// the folder's own name, not its path, so this is only a hint.
func kimiWorkMarkerDir(sessions, path string) string {
	rel, err := filepath.Rel(sessions, path)
	if err != nil {
		return ""
	}
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if len(parts) < 2 || !strings.HasPrefix(parts[0], "wd_") {
		return ""
	}
	name := strings.TrimPrefix(parts[0], "wd_")
	if i := strings.LastIndex(name, "_"); i > 0 {
		name = name[:i]
	}
	return name
}

// readKimi converts a Kimi Code wire file.
func readKimi(path string) (importedSession, error) {
	out := importedSession{}
	if conv := kimiConvDir(path); conv != "" {
		state := readKimiState(filepath.Join(conv, "state.json"))
		out.Cwd = firstNonEmpty(state.Cwd, state.WorkDir)
		out.Title = firstNonEmpty(importTitle(state.Title), importTitle(state.LastPrompt))
	}
	appended := kimiAppendedKeys(path)
	seen := map[string]bool{}
	names := map[string]string{}
	err := walkKimiWire(path, func(rec map[string]any) {
		entry, key := kimiEntry(rec)
		if entry == nil {
			return
		}
		// A message is written twice (a context snapshot and the appended
		// message); the appended one is the full copy, so a context record
		// whose key it also wrote is skipped.
		if asString(rec["type"]) != "agent.message.appended" && appended[key] {
			return
		}
		if seen[key] {
			return
		}
		seen[key] = true
		kimiMessage(entry, &out, names)
	})
	out.Messages = repairToolResults(out.Messages)
	return out, err
}

// readKimiWork converts a Kimi Work wire file, whose assistant turns arrive
// as step events rather than finished messages.
func readKimiWork(path string) (importedSession, error) {
	out := importedSession{}
	conv := filepath.Dir(filepath.Dir(filepath.Dir(path)))
	state := readKimiState(filepath.Join(conv, "state.json"))
	out.Cwd = firstNonEmpty(state.WorkDir, state.Cwd)
	out.Title = importTitle(state.Title)
	if out.Title == "" {
		out.Title = importTitle(state.LastPrompt)
	}
	names := map[string]string{}
	type step struct {
		blocks []importBlock
		calls  []string
		at     time.Time
		model  string
	}
	steps := map[string]*step{}
	order := []string{}
	open := func(uuid string) *step {
		if s, ok := steps[uuid]; ok {
			return s
		}
		s := &step{}
		steps[uuid] = s
		order = append(order, uuid)
		return s
	}
	emit := func(uuid, finish string) {
		s := open(uuid)
		if len(s.blocks) > 0 {
			out.Messages = append(out.Messages, importMessage{Role: "assistant", Blocks: s.blocks, Timestamp: s.at,
				Provider: "kimi-work", Model: orDefault(s.model, "kimi-work-import"),
				StopReason: importStopReason(finish, len(s.calls) > 0)})
		}
		delete(steps, uuid)
	}
	err := walkKimiWire(path, func(rec map[string]any) {
		if asString(rec["type"]) != "context.append_loop_event" {
			if entry, _ := kimiEntry(rec); entry != nil {
				kimiMessage(entry, &out, names)
			}
			return
		}
		event := asMap(rec["event"])
		if event == nil {
			event = rec
		}
		kind := asString(event["type"])
		uuid := firstNonEmpty(asString(event["uuid"]), asString(event["stepUuid"]))
		switch kind {
		case "step.begin":
			open(uuid)
		case "content.part":
			s := open(firstNonEmpty(asString(event["stepUuid"]), uuid))
			part := asMap(event["part"])
			if part == nil {
				part = event
			}
			blocks, calls := kimiPartBlocks(part)
			if s.at.IsZero() {
				s.at = importNow()
			}
			s.blocks = append(s.blocks, blocks...)
			s.calls = append(s.calls, calls...)
			if m := asString(event["model"]); m != "" {
				s.model = m
			}
		case "step.end":
			emit(uuid, asString(event["finishReason"]))
		}
	})
	for _, uuid := range order {
		if s, ok := steps[uuid]; ok && len(s.blocks) > 0 {
			out.Messages = append(out.Messages, importMessage{Role: "assistant", Blocks: s.blocks, Timestamp: s.at,
				Provider: "kimi-work", Model: orDefault(s.model, "kimi-work-import"),
				StopReason: importStopReason("", len(s.calls) > 0)})
		}
	}
	out.Messages = repairToolResults(out.Messages)
	return out, err
}

// kimiConvDir reads a wire file's conversation folder.
func kimiConvDir(path string) string {
	return filepath.Dir(filepath.Dir(filepath.Dir(path)))
}

// walkKimiWire reads a wire file's records.
func walkKimiWire(path string, fn func(rec map[string]any)) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
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
		fn(rec)
	}
	return sc.Err()
}

// kimiAppendedKeys collects the messages Kimi Code writes twice: once as a
// context snapshot and once as an appended message. The appended one is
// kept.
func kimiAppendedKeys(path string) map[string]bool {
	keys := map[string]bool{}
	_ = walkKimiWire(path, func(rec map[string]any) {
		if asString(rec["type"]) != "agent.message.appended" {
			return
		}
		if entry, key := kimiEntry(rec); entry != nil {
			keys[key] = true
		}
	})
	return keys
}

// kimiEntry reads one message record, with the key that tells two writings
// of it apart.
func kimiEntry(rec map[string]any) (map[string]any, string) {
	kind := asString(rec["type"])
	var msg map[string]any
	switch kind {
	case "context.append_message":
		msg = asMap(rec["message"])
	case "agent.message.appended":
		envelope := asMap(rec["message"])
		if envelope == nil {
			return nil, ""
		}
		msg = asMap(envelope["message"])
		if msg == nil {
			msg = envelope
		}
		rec = envelope
	default:
		return nil, ""
	}
	if msg == nil {
		return nil, ""
	}
	id := asString(msg["id"])
	if id != "" {
		return msg, "id:" + id
	}
	role := asString(msg["role"])
	callID := asString(msg["toolCallId"])
	sig := mustJSON(msg["content"])
	tools := mustJSON(msg["toolCalls"])
	sum := importToken(role + string(sig) + string(tools))
	return msg, "sig:" + role + ":" + callID + ":" + sum
}

// kimiMessage writes one Kimi message into the session.
func kimiMessage(msg map[string]any, out *importedSession, names map[string]string) {
	role := asString(msg["role"])
	at := importTimeValue{}
	if meta := asMap(msg["meta"]); meta != nil {
		at = importTime(meta["timestamp"])
	}
	when := at.time
	if out.Updated.Before(when) {
		out.Updated = when
	}
	switch role {
	case "user":
		text := kimiText(msg["content"])
		if text == "" {
			return
		}
		out.Messages = append(out.Messages, importMessage{Role: "user", Timestamp: when,
			Blocks: []importBlock{{Kind: "text", Text: text}}})
		if out.Title == "" {
			out.Title = firstLine(text, 60)
		}
	case "tool":
		callID := asString(msg["toolCallId"])
		name := orDefault(names[callID], "tool")
		out.Messages = append(out.Messages, importMessage{Role: "toolResult", Text: kimiText(msg["content"]),
			Timestamp: when, ToolCallID: callID, ToolName: name})
	case "assistant":
		blocks, _ := kimiBlocks(msg["content"])
		extra, callIDs := kimiToolCalls(msg["toolCalls"])
		blocks = append(blocks, extra...)
		for _, call := range callIDs {
			names[call.ID] = call.Name
		}
		if len(blocks) == 0 {
			return
		}
		finish := ""
		model := ""
		if meta := asMap(msg["meta"]); meta != nil {
			if finish == "" {
				finish = asString(asMap(meta["finish"])["finishReason"])
			}
			if m := asString(meta["model"]); m != "" {
				model = m
			}
		}
		out.Messages = append(out.Messages, importMessage{Role: "assistant", Blocks: blocks, Timestamp: when,
			Provider: "kimi", Model: orDefault(model, "kimi-import"),
			StopReason: importStopReason(finish, len(callIDs) > 0)})
	}
}

// kimiText joins a Kimi content's text parts.
func kimiText(v any) string {
	return familyText(v)
}

// kimiBlocks maps a Kimi content list.
func kimiBlocks(v any) ([]importBlock, []string) {
	var items []any
	switch v := v.(type) {
	case string:
		if strings.TrimSpace(v) == "" {
			return nil, nil
		}
		return []importBlock{{Kind: "text", Text: v}}, nil
	case []any:
		items = v
	default:
		return nil, nil
	}
	var blocks []importBlock
	var calls []string
	for _, item := range items {
		b := asMap(item)
		if b == nil {
			continue
		}
		switch asString(b["type"]) {
		case "text":
			blocks = append(blocks, importBlock{Kind: "text", Text: asString(b["text"])})
		case "think", "thinking", "reasoning":
			text := firstNonEmpty(asString(b["think"]), asString(b["thinking"]), asString(b["text"]))
			if text != "" {
				blocks = append(blocks, importBlock{Kind: "thinking", Thinking: text})
			}
		case "toolCall", "tool_call", "function_call":
			call := kimiCall(b)
			blocks = append(blocks, importBlock{Kind: "toolCall", ID: call.ID, Name: call.Name,
				Arguments: importArguments(b["arguments"])})
			calls = append(calls, call.ID)
		default:
			if out, err := json.Marshal(b); err == nil {
				blocks = append(blocks, importBlock{Kind: "text", Text: string(out)})
			}
		}
	}
	return blocks, calls
}

// kimiToolCalls reads the tool calls written beside a Kimi message.
func kimiToolCalls(v any) ([]importBlock, []importToolCall) {
	items := asList(v)
	var blocks []importBlock
	var calls []importToolCall
	for i, item := range items {
		b := asMap(item)
		if b == nil {
			continue
		}
		call := kimiCall(b)
		if call.ID == "" {
			call.ID = importToken("kimi-" + call.Name + "-" + string(rune('a'+i)))
		}
		blocks = append(blocks, importBlock{Kind: "toolCall", ID: call.ID, Name: call.Name,
			Arguments: importArguments(b["arguments"])})
		calls = append(calls, call)
	}
	return blocks, calls
}

// kimiCall reads a tool call, in either shape Kimi writes it.
func kimiCall(b map[string]any) importToolCall {
	name := asString(b["name"])
	args := b["arguments"]
	if fn := asMap(b["function"]); fn != nil {
		name = firstNonEmpty(asString(fn["name"]), name)
		if args == nil {
			args = fn["arguments"]
		}
	}
	call := importToolCall{ID: asString(b["id"]), Name: orDefault(name, "tool")}
	_ = args
	return call
}

// kimiPartBlocks maps one step part of a Kimi Work turn.
func kimiPartBlocks(part map[string]any) ([]importBlock, []string) {
	return kimiBlocks([]any{part})
}

// importNow is the time a source without one is stamped with.
func importNow() time.Time { return time.Now() }
