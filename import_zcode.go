//go:build !js && !android && !ios

package main

// ZCode keeps its whole history in one SQLite database: sessions, their
// messages, and the parts a message is made of.

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

// sourceZCode reads ZCode's database.
var sourceZCode = &importSource{
	Key: "zcode", Label: "ZCode", Version: 1,
	Roots: func() []string { return []string{importRoot("zcode", ".zcode", "cli", "db")} },
	Scan:  scanZCode,
	Read:  readZCode,
	Sniff: func(head []byte) bool { return false },
}

// zcodeDB is where ZCode keeps its database.
func zcodeDB(root string) string { return root + string(os.PathSeparator) + "db.sqlite" }

// scanZCode lists the sessions in ZCode's database.
func scanZCode(root string) ([]importCandidate, error) {
	path := zcodeDB(root)
	if _, err := os.Stat(path); err != nil {
		return nil, nil
	}
	db, err := openImportDB(path)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	counts, latest, err := zcodeCounts(db)
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(`select id, coalesce(directory,''), coalesce(title,''), time_created, time_updated
		from session order by time_updated desc`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []importCandidate
	for rows.Next() {
		var id, dir, title string
		var created, updated any
		if rows.Scan(&id, &dir, &title, &created, &updated) != nil {
			continue
		}
		if strings.HasPrefix(id, "sess_subagent_") {
			continue
		}
		cand := importCandidate{Source: "zcode", ID: id, Path: dbSessionPath(path, id), Cwd: dir, Title: importTitle(title),
			Count: counts[id], Size: int64(counts[id]), Updated: importDBTime(updated)}
		if at := latest[id]; at.After(cand.Updated) {
			cand.Updated = at
		}
		if cand.Updated.IsZero() {
			cand.Updated = importDBTime(created)
		}
		cand.MTime = cand.Updated
		out = append(out, cand)
	}
	return out, rows.Err()
}

// zcodeCounts counts each session's messages and finds its last change.
func zcodeCounts(db *sql.DB) (map[string]int, map[string]time.Time, error) {
	counts := map[string]int{}
	latest := map[string]time.Time{}
	rows, err := db.Query(`select session_id, count(*), max(time_updated) from message group by session_id`)
	if err != nil {
		return counts, latest, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var n int64
		var updated any
		if rows.Scan(&id, &n, &updated) == nil {
			counts[id] = int(n)
			latest[id] = importDBTime(updated)
		}
	}
	return counts, latest, nil
}

// zcodeMessage is one message and its parts.
type zcodeMessage struct {
	id      string
	data    map[string]any
	parts   []map[string]any
	partIDs []string
}

// readZCode converts one session into pi's terms. The path is the database
// and the session's id, joined with a hash.
func readZCode(path string) (importedSession, error) {
	dbPath, id := splitDBSession(path)
	if id == "" {
		return importedSession{}, fmt.Errorf("这个会话缺少 ID")
	}
	return readZCodeSession(dbPath, id)
}

// readZCodeSession converts one ZCode session.
func readZCodeSession(dbPath, id string) (importedSession, error) {
	db, err := openImportDB(dbPath)
	if err != nil {
		return importedSession{}, err
	}
	defer db.Close()
	out := importedSession{}
	row := db.QueryRow(`select coalesce(directory,''), coalesce(title,''), time_created, time_updated from session where id = ?`, id)
	var dir, title string
	var created, updated any
	if err := row.Scan(&dir, &title, &created, &updated); err != nil {
		return out, err
	}
	out.Cwd = dir
	out.Title = importTitle(title)
	out.Updated = importDBTime(updated)
	msgs, err := zcodeMessages(db, id)
	if err != nil {
		return out, err
	}
	names := map[string]string{}
	for _, m := range msgs {
		data := m.data
		role := asString(data["role"])
		if role != "user" && role != "assistant" {
			continue
		}
		semantics := asMap(data["semantics"])
		switch {
		case role == "user" && (asString(semantics["kind"]) == "todo_reminder" || asString(semantics["kind"]) == "background_notification"):
			continue
		case role == "assistant" && asString(semantics["origin"]) == "system":
			continue
		}
		blocks, results, calls := zcodeBlocks(m.parts, role, names)
		if len(blocks) == 0 && len(results) == 0 {
			continue
		}
		if len(blocks) > 0 {
			msg := importMessage{Role: role, Blocks: blocks, Timestamp: importDBTime(data["time_created"])}
			if role == "assistant" {
				msg.Provider = asString(data["providerID"])
				msg.Model = asString(data["modelID"])
				msg.Usage = importUsageOf(data["tokens"])
				msg.StopReason = importStopReason(asString(data["finish"]), len(calls) > 0)
			}
			if out.Title == "" && role == "user" {
				out.Title = firstUserBlocks(blocks)
			}
			out.Messages = append(out.Messages, msg)
		}
		out.Messages = append(out.Messages, results...)
		for _, call := range calls {
			names[call.ID] = call.Name
		}
	}
	out.Messages = repairToolResults(out.Messages)
	return out, nil
}

// zcodeMessages reads a session's messages and their parts.
func zcodeMessages(db *sql.DB, id string) ([]zcodeMessage, error) {
	rows, err := db.Query(`select id, time_created, time_updated, data from message where session_id = ?
		order by coalesce(sequence, time_created), time_created`, id)
	if err != nil {
		return nil, err
	}
	var msgs []zcodeMessage
	index := map[string]int{}
	for rows.Next() {
		var mid string
		var created, updated, data any
		if rows.Scan(&mid, &created, &updated, &data) != nil {
			continue
		}
		entry := importDBJSON(data)
		if entry == nil {
			continue
		}
		if _, ok := entry["time_created"]; !ok {
			entry["time_created"] = created
		}
		index[mid] = len(msgs)
		msgs = append(msgs, zcodeMessage{id: mid, data: entry})
	}
	rows.Close()
	parts, err := db.Query(`select message_id, id, time_created, data from part where session_id = ?
		order by coalesce(sequence, time_created), time_created`, id)
	if err != nil {
		return msgs, nil
	}
	defer parts.Close()
	for parts.Next() {
		var mid, pid string
		var created, data any
		if parts.Scan(&mid, &pid, &created, &data) != nil {
			continue
		}
		at, ok := index[mid]
		if !ok {
			continue
		}
		entry := importDBJSON(data)
		if entry == nil {
			continue
		}
		if _, ok := entry["time_created"]; !ok {
			entry["time_created"] = created
		}
		msgs[at].parts = append(msgs[at].parts, entry)
		msgs[at].partIDs = append(msgs[at].partIDs, pid)
	}
	return msgs, nil
}

// zcodeNoiseParts are the parts that only describe process.
var importNoiseParts = map[string]bool{"step-start": true, "step-finish": true, "timeline": true,
	"snapshot": true, "patch": true, "compaction": true}

// zcodeBlocks maps one message's parts, pulling tool results out so they
// follow the assistant turn that asked for them.
func zcodeBlocks(parts []map[string]any, role string, names map[string]string) ([]importBlock, []importMessage, []importToolCall) {
	var blocks []importBlock
	var results []importMessage
	var calls []importToolCall
	for i, part := range parts {
		kind := asString(part["type"])
		if importNoiseParts[kind] {
			continue
		}
		switch kind {
		case "text":
			if t := asString(part["text"]); t != "" {
				blocks = append(blocks, importBlock{Kind: "text", Text: t})
			}
		case "reasoning":
			if t := asString(part["text"]); t != "" {
				blocks = append(blocks, importBlock{Kind: "thinking", Thinking: t})
			}
		case "tool":
			callID := firstNonEmpty(asString(part["callID"]), importToken(fmt.Sprint(i)))
			name := orDefault(asString(part["tool"]), "tool")
			state := asMap(part["state"])
			blocks = append(blocks, importBlock{Kind: "toolCall", ID: callID, Name: name,
				Arguments: importArguments(state["input"])})
			calls = append(calls, importToolCall{ID: callID, Name: name})
			text := toolStateText(state)
			at := importDBTime(part["time_created"])
			if t := asMap(part["time"]); t != nil {
				if end := importDBTime(t["end"]); !end.IsZero() {
					at = end
				}
			}
			results = append(results, importMessage{Role: "toolResult", ToolCallID: callID, ToolName: name,
				Text: text, Timestamp: at, IsError: asString(state["status"]) == "error"})
		case "file":
			blocks = append(blocks, importImageBlock(asString(part["data"]), asString(part["mime"]),
				firstNonEmpty(asString(part["filename"]), asString(part["url"]))))
		default:
			if out, err := json.Marshal(part); err == nil {
				blocks = append(blocks, importBlock{Kind: "text", Text: string(out)})
			}
		}
	}
	if role != "assistant" {
		// A tool result inside a user turn answers an earlier call.
		for i := range results {
			results[i].ToolName = orDefault(names[results[i].ToolCallID], results[i].ToolName)
		}
	}
	return blocks, results, calls
}

// toolStateText is what a tool said: its output, or why it failed.
func toolStateText(state map[string]any) string {
	if state == nil {
		return ""
	}
	if text := importToolOutput(state["output"]); strings.TrimSpace(text) != "" {
		return text
	}
	return importToolOutput(state["error"])
}

// firstUserBlocks is the first thing a user said, for a name.
func firstUserBlocks(blocks []importBlock) string {
	for _, b := range blocks {
		if b.Kind == "text" && strings.TrimSpace(b.Text) != "" {
			return firstLine(b.Text, 60)
		}
	}
	return ""
}
