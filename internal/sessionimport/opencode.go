//go:build !js && !android && !ios

package sessionimport

// OpenCode keeps its history in one SQLite database too: a session, its
// messages, and the parts each message is made of. Two generations of
// schema exist; both are read into the same shape.

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"
)

// sourceOpenCode reads OpenCode's database.
var OpenCode = &Source{
	Key: "opencode", Label: "OpenCode", Version: 1,
	Roots: func() []string { return []string{importRoot("opencode", ".local", "share", "opencode")} },
	Scan:  ScanOpenCode,
	Read:  readOpenCode,
	Sniff: func(head []byte) bool { return false },
}

// opencodeDB is where OpenCode keeps its database.
func OpenCodeDB(root string) string { return root + string(os.PathSeparator) + "opencode.db" }

// scanOpenCode lists the sessions in OpenCode's database.
func ScanOpenCode(root string) ([]Candidate, error) {
	path := OpenCodeDB(root)
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
	hasV1, hasV2 := opencodeV1(tables), opencodeV2(tables)
	if !hasV1 && !hasV2 {
		return nil, nil
	}
	// A 2.x database still holds the sessions it wrote before upgrading, so
	// both generations are listed; the same id from 2.x wins.
	byID := map[string]Candidate{}
	if hasV1 {
		rows, err := scanOpenCodeV1(db, path, tables)
		if err != nil {
			return nil, err
		}
		for _, cand := range rows {
			byID[cand.ID] = cand
		}
	}
	if hasV2 {
		rows, err := scanOpenCodeV2(db, path, tables)
		if err != nil {
			return nil, err
		}
		for _, cand := range rows {
			byID[cand.ID] = cand
		}
	}
	out := make([]Candidate, 0, len(byID))
	for _, cand := range byID {
		out = append(out, cand)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Updated.After(out[j].Updated) })
	return out, nil
}

// scanOpenCodeV1 lists the sessions of OpenCode 1.x.
func scanOpenCodeV1(db *sql.DB, path string, tables map[string]map[string]bool) ([]Candidate, error) {
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
	var out []Candidate
	for rows.Next() {
		var id, dir, title string
		var updated any
		if rows.Scan(&id, &dir, &title, &updated) != nil {
			continue
		}
		cand := Candidate{Source: "opencode", ID: id, Path: dbSessionPath(path, id), Cwd: dir,
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
func readOpenCode(path string) (Session, error) {
	dbPath, id := splitDBSession(path)
	if id == "" {
		return Session{}, fmt.Errorf("这个会话缺少 ID")
	}
	db, err := openImportDB(dbPath)
	if err != nil {
		return Session{}, err
	}
	defer db.Close()
	if tables, err := importDBTables(db); err == nil && opencodeV2(tables) {
		if out, ok, err := readOpenCodeV2(db, id); ok || err != nil {
			return out, err
		}
	}
	out := Session{}
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
			msg := Message{Role: role, Blocks: blocks, Timestamp: importDBTime(m.created)}
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

// opencodeV2 reports whether the database carries OpenCode 2.x's tables.
// The message table only counts when it can be ordered: an early 2.x build
// wrote it without the seq column.
func opencodeV2(tables map[string]map[string]bool) bool {
	cols, ok := tables["session_message"]
	return tables["session_v2"] != nil && ok && cols["seq"]
}

// opencodeV1 reports whether the database carries OpenCode 1.x's tables.
func opencodeV1(tables map[string]map[string]bool) bool {
	return tables["session"] != nil && tables["message"] != nil && tables["part"] != nil
}

// scanOpenCodeV2 lists the sessions of OpenCode 2.x, which writes only the
// top-level conversations here.
func scanOpenCodeV2(db *sql.DB, path string, tables map[string]map[string]bool) ([]Candidate, error) {
	counts, latest := opencodeV2Counts(db)
	hasProject := tables["project"] != nil
	query := `select s.id, coalesce(s.directory,''), coalesce(cast(s.title as text),''), s.time_updated
		from session_v2 s where coalesce(s.parent_id,'') = '' order by s.time_updated desc`
	if hasProject {
		query = `select s.id, coalesce(s.directory,''), coalesce(cast(s.title as text),''), s.time_updated
			from session_v2 s left join project p on p.id = s.project_id
			where coalesce(s.parent_id,'') = '' order by s.time_updated desc`
	}
	rows, err := db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Candidate
	for rows.Next() {
		var id, dir, title string
		var updated any
		if rows.Scan(&id, &dir, &title, &updated) != nil {
			continue
		}
		cand := Candidate{Source: "opencode", ID: id, Path: dbSessionPath(path, id), Cwd: dir,
			Title: importTitle(title), Count: counts[id], Size: int64(counts[id]), Updated: importDBTime(updated)}
		if at := latest[id]; at.After(cand.Updated) {
			cand.Updated = at
		}
		cand.MTime = cand.Updated
		out = append(out, cand)
	}
	return out, rows.Err()
}

// opencodeV2Counts counts each 2.x session's turns and finds its last change.
func opencodeV2Counts(db *sql.DB) (map[string]int, map[string]time.Time) {
	counts := map[string]int{}
	latest := map[string]time.Time{}
	rows, err := db.Query(`select session_id, count(*), max(time_updated) from session_message group by session_id`)
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

// readOpenCodeV2 converts one 2.x session. A database may hold both
// generations; the session says which one wrote it.
func readOpenCodeV2(db *sql.DB, id string) (Session, bool, error) {
	out := Session{}
	row := db.QueryRow(`select coalesce(directory,''), coalesce(cast(title as text),''), coalesce(time_updated,0)
		from session_v2 where id = ?`, id)
	var dir, title string
	var updated any
	if err := row.Scan(&dir, &title, &updated); err != nil {
		if err == sql.ErrNoRows {
			return out, false, nil
		}
		return out, false, err
	}
	out.Cwd, out.Title = dir, importTitle(title)
	out.Updated = importDBTime(updated)
	rows, err := db.Query(`select id, type, time_created, data from session_message where session_id = ? order by seq asc`, id)
	if err != nil {
		return out, true, err
	}
	defer rows.Close()
	names := map[string]string{}
	for rows.Next() {
		var mid, kind string
		var created, data any
		if rows.Scan(&mid, &kind, &created, &data) != nil {
			continue
		}
		entry := importDBJSON(data)
		if entry == nil {
			continue
		}
		at := importDBTime(created)
		if out.Updated.Before(at) {
			out.Updated = at
		}
		switch kind {
		case "user":
			blocks := opencodeV2UserBlocks(entry)
			if len(blocks) == 0 {
				continue
			}
			out.Messages = append(out.Messages, Message{Role: "user", Timestamp: at, Blocks: blocks})
			if out.Title == "" {
				out.Title = firstUserBlocks(blocks)
			}
		case "assistant":
			blocks, results, calls := opencodeV2AssistantBlocks(entry, mid, names)
			if len(blocks) == 0 && len(results) == 0 {
				continue
			}
			model := asMap(entry["model"])
			msg := Message{Role: "assistant", Timestamp: at, Blocks: blocks,
				Provider: asString(model["providerID"]), Model: asString(model["id"]),
				StopReason: importStopReason(asString(entry["finish"]), calls > 0),
				Usage:      importUsageOf(entry["tokens"])}
			if len(blocks) > 0 {
				out.Messages = append(out.Messages, msg)
			}
			out.Messages = append(out.Messages, results...)
		}
	}
	out.Messages = repairToolResults(out.Messages)
	return out, true, rows.Err()
}

// opencodeV2UserBlocks is a 2.x user turn's words and files.
func opencodeV2UserBlocks(entry map[string]any) []Block {
	var blocks []Block
	if text := stripInjectedReminder(asString(entry["text"])); text != "" {
		blocks = append(blocks, Block{Kind: "text", Text: text})
	}
	for _, file := range asList(entry["files"]) {
		m := asMap(file)
		if m == nil {
			continue
		}
		mime := firstNonEmpty(asString(m["mime"]), asString(m["mimeType"]))
		label := firstNonEmpty(asString(m["name"]), asString(m["filename"]), asString(m["uri"]))
		data := asString(m["data"])
		if data == "" {
			if src := asMap(m["source"]); src != nil {
				data = asString(src["data"])
				mime = firstNonEmpty(mime, asString(src["mimeType"]))
			}
		}
		if strings.HasPrefix(mime, "image/") || data != "" {
			blocks = append(blocks, importImageBlock(data, mime, label))
			continue
		}
		blocks = append(blocks, importPlaceholder("attachment", label))
	}
	return blocks
}

// opencodeV2AssistantBlocks maps a 2.x assistant turn.
func opencodeV2AssistantBlocks(entry map[string]any, messageID string, names map[string]string) (blocks []Block, results []Message, calls int) {
	for i, item := range asList(entry["content"]) {
		m := asMap(item)
		if m == nil {
			continue
		}
		switch asString(m["type"]) {
		case "text":
			if t := asString(m["text"]); t != "" {
				blocks = append(blocks, Block{Kind: "text", Text: t})
			}
		case "reasoning":
			if t := firstNonEmpty(asString(m["text"]), asString(m["thinking"])); t != "" {
				blocks = append(blocks, Block{Kind: "thinking", Thinking: t})
			}
		case "tool":
			callID := firstNonEmpty(asString(m["id"]), fmt.Sprintf("%s:%d", messageID, i))
			name := orDefault(asString(m["name"]), "tool")
			state := asMap(m["state"])
			blocks = append(blocks, Block{Kind: "toolCall", ID: callID, Name: name,
				Arguments: importArguments(state["input"])})
			calls++
			names[callID] = name
			results = append(results, Message{Role: "toolResult", ToolCallID: callID, ToolName: name,
				Text: opencodeV2ToolOutput(state), IsError: asString(state["status"]) == "error"})
		default:
			if out, err := json.Marshal(m); err == nil {
				blocks = append(blocks, Block{Kind: "text", Text: string(out)})
			}
		}
	}
	return blocks, results, calls
}

// opencodeV2ToolOutput is what a 2.x tool call left behind: its content
// parts, or why it failed.
func opencodeV2ToolOutput(state map[string]any) string {
	if state == nil {
		return ""
	}
	var parts []string
	for _, item := range asList(state["content"]) {
		m := asMap(item)
		if m == nil {
			continue
		}
		if t := asString(m["text"]); t != "" {
			parts = append(parts, t)
			continue
		}
		label := firstNonEmpty(asString(m["name"]), asString(m["uri"]))
		if label == "" {
			label = "attachment"
		}
		parts = append(parts, "[attachment: "+label+"]")
	}
	if text := strings.Join(parts, "\n"); text != "" {
		return text
	}
	if text := importToolOutput(state["output"]); strings.TrimSpace(text) != "" {
		return text
	}
	if errMap := asMap(state["error"]); errMap != nil {
		if msg := asString(errMap["message"]); msg != "" {
			return msg
		}
		if out, err := json.Marshal(errMap); err == nil {
			return string(out)
		}
	}
	return ""
}

// opencodeBlocks maps one message's parts.
func opencodeBlocks(parts []map[string]any, role string) ([]Block, []Message, []importToolCall) {
	var blocks []Block
	var results []Message
	var calls []importToolCall
	for i, part := range parts {
		kind := asString(part["type"])
		if importNoiseParts[kind] {
			continue
		}
		switch kind {
		case "text":
			if t := asString(part["text"]); t != "" {
				blocks = append(blocks, Block{Kind: "text", Text: t})
			}
		case "reasoning":
			if t := firstNonEmpty(asString(part["text"]), asString(part["thinking"])); t != "" {
				blocks = append(blocks, Block{Kind: "thinking", Thinking: t})
			}
		case "tool":
			callID := firstNonEmpty(asString(part["callID"]), importToken(fmt.Sprint("opencode", i)))
			name := orDefault(asString(part["tool"]), "tool")
			state := asMap(part["state"])
			call := importToolCall{ID: callID, Name: name}
			calls = append(calls, call)
			text := toolStateText(state)
			result := Message{Role: "toolResult", ToolCallID: callID, ToolName: name, Text: text,
				IsError: asString(state["status"]) == "error"}
			if role == "assistant" {
				blocks = append(blocks, Block{Kind: "toolCall", ID: callID, Name: name,
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
				blocks = append(blocks, Block{Kind: "text", Text: string(out)})
			}
		}
	}
	return blocks, results, calls
}
