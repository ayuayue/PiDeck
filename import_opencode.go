//go:build !js && !android && !ios

package main

// OpenCode keeps its history in one SQLite database too: a session, its
// messages, and the parts each message is made of. Two generations of
// schema exist; both are read into the same shape.

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

// sourceOpenCode reads OpenCode's database.
var sourceOpenCode = &importSource{
	Key: "opencode", Label: "OpenCode", Version: 1,
	Roots: func() []string { return []string{importRoot("opencode", ".local", "share", "opencode")} },
	Scan:  scanOpenCode,
	Read:  readOpenCode,
	Sniff: func(head []byte) bool { return false },
}

// opencodeDB is where OpenCode keeps its database.
func opencodeDB(root string) string { return root + string(os.PathSeparator) + "opencode.db" }

// scanOpenCode lists the sessions in OpenCode's database.
func scanOpenCode(root string) ([]importCandidate, error) {
	path := opencodeDB(root)
	if _, err := os.Stat(path); err != nil {
		return nil, nil
	}
	db, err := openImportDB(path)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	tables, err := importDBTables(db)
	if err != nil {
		return nil, err
	}
	if _, ok := tables["session"]; !ok {
		return nil, nil
	}
	counts, latest := opencodeCounts(db)
	query := `select s.id, coalesce(s.directory,''), coalesce(cast(s.title as text),''), s.time_updated
		from session s order by s.time_updated desc`
	if _, ok := tables["project"]; ok {
		query = `select s.id, coalesce(s.directory,''), coalesce(cast(s.title as text),''), s.time_updated
			from session s left join project p on p.id = s.project_id order by s.time_updated desc`
	}
	rows, err := db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []importCandidate
	for rows.Next() {
		var id, dir, title string
		var updated any
		if rows.Scan(&id, &dir, &title, &updated) != nil {
			continue
		}
		cand := importCandidate{Source: "opencode", ID: id, Path: dbSessionPath(path, id), Cwd: dir,
			Title: importTitle(title), Count: counts[id], Size: int64(counts[id]), Updated: importDBTime(updated)}
		if at := latest[id]; at.After(cand.Updated) {
			cand.Updated = at
		}
		cand.MTime = cand.Updated
		out = append(out, cand)
	}
	return out, rows.Err()
}

// opencodeCounts counts each session's messages and finds its last change.
func opencodeCounts(db *sql.DB) (map[string]int, map[string]time.Time) {
	counts := map[string]int{}
	latest := map[string]time.Time{}
	rows, err := db.Query(`select session_id, count(*), max(time_updated) from message group by session_id`)
	if err != nil {
		return counts, latest
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
	return counts, latest
}

// readOpenCode converts one session into pi's terms.
func readOpenCode(path string) (importedSession, error) {
	dbPath, id := splitDBSession(path)
	if id == "" {
		return importedSession{}, fmt.Errorf("这个会话缺少 ID")
	}
	db, err := openImportDB(dbPath)
	if err != nil {
		return importedSession{}, err
	}
	defer db.Close()
	out := importedSession{}
	row := db.QueryRow(`select coalesce(directory,''), coalesce(cast(title as text),''), time_updated from session where id = ?`, id)
	var dir, title string
	var updated any
	if err := row.Scan(&dir, &title, &updated); err != nil {
		return out, err
	}
	out.Cwd, out.Title = dir, importTitle(title)
	out.Updated = importDBTime(updated)
	msgs, err := opencodeMessages(db, id)
	if err != nil {
		return out, err
	}
	for _, m := range msgs {
		role := asString(m.data["role"])
		if role != "user" && role != "assistant" {
			continue
		}
		blocks, results, calls := opencodeBlocks(m.parts, role)
		if len(blocks) == 0 && len(results) == 0 {
			continue
		}
		if len(blocks) > 0 {
			msg := importMessage{Role: role, Blocks: blocks, Timestamp: importDBTime(m.created)}
			if role == "assistant" {
				msg.Provider = asString(m.data["providerID"])
				msg.Model = asString(m.data["modelID"])
				msg.StopReason = importStopReason(asString(m.data["finish"]), len(calls) > 0)
				msg.Usage = importUsageOf(m.data["tokens"])
			} else if out.Title == "" {
				out.Title = firstUserBlocks(blocks)
			}
			out.Messages = append(out.Messages, msg)
		}
		out.Messages = append(out.Messages, results...)
	}
	out.Messages = repairToolResults(out.Messages)
	return out, nil
}

// opencodeMessage is one message and its parts.
type opencodeMessage struct {
	data    map[string]any
	parts   []map[string]any
	created any
}

// opencodeMessages reads a session's messages and their parts.
func opencodeMessages(db *sql.DB, id string) ([]opencodeMessage, error) {
	rows, err := db.Query(`select id, time_created, data from message where session_id = ? order by time_created asc`, id)
	if err != nil {
		return nil, err
	}
	var msgs []opencodeMessage
	index := map[string]int{}
	for rows.Next() {
		var mid string
		var created, data any
		if rows.Scan(&mid, &created, &data) != nil {
			continue
		}
		entry := importDBJSON(data)
		if entry == nil {
			continue
		}
		index[mid] = len(msgs)
		msgs = append(msgs, opencodeMessage{data: entry, created: created})
	}
	rows.Close()
	parts, err := db.Query(`select message_id, time_created, data from part where session_id = ? order by time_created asc`, id)
	if err != nil {
		return msgs, nil
	}
	defer parts.Close()
	for parts.Next() {
		var mid string
		var created, data any
		if parts.Scan(&mid, &created, &data) != nil {
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
		msgs[at].parts = append(msgs[at].parts, entry)
	}
	return msgs, nil
}

// opencodeBlocks maps one message's parts.
func opencodeBlocks(parts []map[string]any, role string) ([]importBlock, []importMessage, []importToolCall) {
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
			if t := firstNonEmpty(asString(part["text"]), asString(part["thinking"])); t != "" {
				blocks = append(blocks, importBlock{Kind: "thinking", Thinking: t})
			}
		case "tool":
			callID := firstNonEmpty(asString(part["callID"]), importToken(fmt.Sprint("opencode", i)))
			name := orDefault(asString(part["tool"]), "tool")
			state := asMap(part["state"])
			call := importToolCall{ID: callID, Name: name}
			calls = append(calls, call)
			text := toolStateText(state)
			result := importMessage{Role: "toolResult", ToolCallID: callID, ToolName: name, Text: text,
				IsError: asString(state["status"]) == "error"}
			if role == "assistant" {
				blocks = append(blocks, importBlock{Kind: "toolCall", ID: callID, Name: name,
					Arguments: importArguments(state["input"])})
				results = append(results, result)
				continue
			}
			results = append(results, result)
		case "file":
			mime := firstNonEmpty(asString(part["mime"]), asString(part["mimeType"]))
			label := firstNonEmpty(asString(part["filename"]), asString(part["url"]))
			data := asString(part["data"])
			if data == "" {
				if src := asMap(part["source"]); src != nil {
					data = asString(src["data"])
					mime = firstNonEmpty(mime, asString(src["mimeType"]))
				}
			}
			if strings.HasPrefix(mime, "image/") || data != "" {
				blocks = append(blocks, importImageBlock(data, mime, label))
				continue
			}
			blocks = append(blocks, importPlaceholder("attachment", label))
		default:
			if out, err := json.Marshal(part); err == nil {
				blocks = append(blocks, importBlock{Kind: "text", Text: string(out)})
			}
		}
	}
	return blocks, results, calls
}
