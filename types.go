package main

// The data the screen reads: sessions, turns, tool runs, models and usage.

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/nsgo-dev/nsgo/ui/chat"
)

// sessionStatus is a session's lifecycle as the sidebar shows it.
type sessionStatus int

const (
	statusIdle sessionStatus = iota
	statusStarting
	statusRunning
	statusWaiting // retrying, compacting, or queued behind work
	statusFailed
)

// modelInfo is one configured model.
type modelInfo struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Provider      string `json:"provider"`
	Reasoning     bool   `json:"reasoning"`
	ContextWindow int    `json:"contextWindow"`
}

// label is a model's name, or its id when it has none.
func (m modelInfo) label() string {
	if m.Name != "" {
		return m.Name
	}
	return m.ID
}

// shortLabel keeps a label readable in a chip.
func (m modelInfo) shortLabel() string {
	name := m.label()
	if i := strings.Index(name, " · "); i > 0 {
		name = name[:i]
	}
	if len([]rune(name)) > 26 {
		name = string([]rune(name)[:25]) + "…"
	}
	return name
}

// usageInfo is what a response cost.
type usageInfo struct {
	Input      int
	Output     int
	CacheRead  int
	CacheWrite int
	Total      int
	Cost       float64
}

func (u usageInfo) add(v usageInfo) usageInfo {
	return usageInfo{Input: u.Input + v.Input, Output: u.Output + v.Output, CacheRead: u.CacheRead + v.CacheRead,
		CacheWrite: u.CacheWrite + v.CacheWrite, Total: u.Total + v.Total, Cost: u.Cost + v.Cost}
}

// toolRun is one executed tool call.
type toolRun struct {
	CallID string
	Name   string
	Action string // a short verb: 运行, 读取, 编辑…
	Detail string // its target: a command, a path, a query
	Output string
	// Diff is what an edit changed, as lines beginning with - or +, and
	// Added/Removed count them.
	Diff    string
	Added   int
	Removed int
	// Nested are the tool calls a tool made itself, one line each.
	Nested     []string
	Status     chat.Status
	IsError    bool
	Start      time.Time
	DurationMs int64
}

// fileChange is one file a turn's tools edited or wrote, with the lines
// they added and removed when the tool reported them.
type fileChange struct {
	Path    string
	Added   int
	Removed int
	Count   int
}

// turnChanges merges the files a turn's tools edited or wrote, in the
// order they first appear.
func turnChanges(t turn) []fileChange {
	var out []fileChange
	at := map[string]int{}
	for _, st := range t.Steps {
		for _, run := range st.Tools {
			if run.Detail == "" || (run.Action != "编辑" && run.Action != "写入") {
				continue
			}
			ix, ok := at[run.Detail]
			if !ok {
				ix = len(out)
				at[run.Detail] = ix
				out = append(out, fileChange{Path: run.Detail})
			}
			out[ix].Added += run.Added
			out[ix].Removed += run.Removed
			out[ix].Count++
		}
	}
	return out
}

// toolDetails is a tool result's details, as the tools that use them send.
type toolDetails struct {
	Diff  string `json:"diff"`
	Patch string `json:"patch"`
	Calls []struct {
		Name       string  `json:"name"`
		Args       string  `json:"args"`
		Status     string  `json:"status"`
		DurationMs float64 `json:"durationMs"`
	} `json:"calls"`
}

// withDetails reads a tool result's details into the run: an edit's diff,
// a nested tool's calls.
func (r *toolRun) withDetails(raw json.RawMessage) {
	if len(raw) == 0 {
		return
	}
	var d toolDetails
	if json.Unmarshal(raw, &d) != nil {
		return
	}
	diff := d.Diff
	if diff == "" && d.Patch != "" {
		for _, line := range strings.Split(d.Patch, "\n") {
			if strings.HasPrefix(line, "---") || strings.HasPrefix(line, "+++") || strings.HasPrefix(line, "@@") {
				continue
			}
			if line != "" {
				diff += line + "\n"
			}
		}
	}
	if diff != "" {
		r.Diff = strings.TrimRight(diff, "\n")
		for _, line := range strings.Split(r.Diff, "\n") {
			switch {
			case strings.HasPrefix(line, "+"):
				r.Added++
			case strings.HasPrefix(line, "-"):
				r.Removed++
			}
		}
	}
	for _, c := range d.Calls {
		line := c.Name
		if args := nestedArgs(c.Args); args != "" {
			line += " " + args
		}
		if c.DurationMs >= 1 {
			line += fmt.Sprintf(" · %dms", int(c.DurationMs))
		}
		r.Nested = append(r.Nested, line)
	}
}

// nestedArgs is a nested call's arguments as a short line.
func nestedArgs(raw string) string {
	var args map[string]any
	if json.Unmarshal([]byte(raw), &args) != nil {
		return shorten(raw, 60)
	}
	for _, k := range []string{"path", "command", "query", "pattern", "url"} {
		if v, ok := args[k].(string); ok && v != "" {
			return shorten(v, 60)
		}
	}
	return ""
}

// turnStep is one assistant message within a turn: its thinking, its prose
// and the tools it called. Its ID is stable from the moment it streams, so
// the same row becomes the committed one.
type turnStep struct {
	ID       string
	Thinking string
	Text     string
	Note     string // a system note: compaction, a summary
	Tools    []toolRun
	Start    time.Time
}

// turn is one request and everything pi did for it.
type turn struct {
	ID      string
	Prompt  string
	Images  []promptImage
	Status  chat.Status
	Start   time.Time
	End     time.Time
	Steps   []turnStep
	Final   string
	Err     string
	Usage   usageInfo
	Tools   int
	Msgs    int    // messages committed, for the next step's ID
	Noticed string // a live status note, such as a retry
	// Plan marks a turn that asked for a plan first; its answer is a
	// plan the user can execute or edit.
	Plan bool
}

// running reports whether the turn can still change.
func (t turn) running() bool { return t.Status == chat.Running || t.Status == chat.Waiting }

// elapsed is how long the turn took, or has been going.
func (t turn) elapsed(now time.Time) time.Duration {
	end := t.End
	if end.IsZero() {
		end = now
	}
	if end.Before(t.Start) {
		return 0
	}
	return end.Sub(t.Start)
}

// sessionStats is what pi reports for the session's totals.
type sessionStats struct {
	UserMessages      int
	AssistantMessages int
	ToolCalls         int
	Tokens            usageInfo
	ContextTokens     int
	ContextWindow     int
	ContextPercent    float64
	Known             bool
}

// extensionAsk is an extension dialog waiting for the user.
type extensionAsk struct {
	ID      string
	Method  string // select, confirm, input, editor
	Title   string
	Message string
	Options []string
	Default string
	Timeout time.Duration
}

// todoItem is one line of the agent's task list, as its todo tool reports
// it. The bar above the composer shows these; the statuses are the ones
// the tools use, normalized.
type todoItem struct {
	Text   string
	Status string // pending, in_progress, completed or cancelled
}

// todoCounts is how a task list stands.
func todoCounts(items []todoItem) (done, total int) {
	for _, it := range items {
		if it.Status == "cancelled" {
			continue
		}
		total++
		if it.Status == "completed" {
			done++
		}
	}
	return done, total
}

// isTodoTool reports whether a tool call carries the task list.
func isTodoTool(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "todo", "todos", "todowrite", "todo_write", "update_todo", "write_todo", "task_list":
		return true
	}
	return false
}

// parseTodoArgs reads a todo tool call's arguments. Tools name the list
// and its fields differently, so it looks for the common shapes rather
// than one schema.
func parseTodoArgs(raw json.RawMessage) ([]todoItem, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	var list []json.RawMessage
	if json.Unmarshal(raw, &list) != nil || len(list) == 0 {
		var args map[string]json.RawMessage
		if json.Unmarshal(raw, &args) != nil {
			return nil, false
		}
		for _, k := range []string{"todos", "items", "tasks", "list", "plan", "steps"} {
			v, ok := args[k]
			if !ok {
				continue
			}
			if json.Unmarshal(v, &list) == nil && len(list) > 0 {
				break
			}
			list = nil
		}
	}
	if len(list) == 0 {
		return nil, false
	}
	var out []todoItem
	for _, rawItem := range list {
		var obj map[string]any
		if json.Unmarshal(rawItem, &obj) != nil {
			// A list of plain strings is a list of pending tasks.
			var text string
			if json.Unmarshal(rawItem, &text) == nil && strings.TrimSpace(text) != "" {
				out = append(out, todoItem{Text: strings.TrimSpace(text), Status: "pending"})
			}
			continue
		}
		text := ""
		for _, k := range []string{"content", "text", "title", "task", "description", "name", "label", "step"} {
			if s, ok := obj[k].(string); ok && strings.TrimSpace(s) != "" {
				text = strings.TrimSpace(s)
				break
			}
		}
		if text == "" {
			continue
		}
		status := "pending"
		if s, ok := obj["status"].(string); ok {
			status = normalizeTodoStatus(s)
		} else if done, ok := obj["done"].(bool); ok && done {
			status = "completed"
		}
		out = append(out, todoItem{Text: text, Status: status})
	}
	if len(out) == 0 {
		return nil, false
	}
	return out, true
}

// normalizeTodoStatus folds the words tools use for a task's state.
func normalizeTodoStatus(s string) string {
	switch strings.ToLower(strings.ReplaceAll(strings.TrimSpace(s), "-", "_")) {
	case "completed", "complete", "done", "finished", "closed":
		return "completed"
	case "in_progress", "inprogress", "doing", "running", "active", "started":
		return "in_progress"
	case "cancelled", "canceled", "skipped", "abandoned":
		return "cancelled"
	}
	return "pending"
}

// todosFromMessages finds the newest task list pi's history carries.
func todosFromMessages(msgs []piMessage) []todoItem {
	var last []todoItem
	for _, m := range msgs {
		if m.Role != "assistant" {
			continue
		}
		for _, b := range m.blocks() {
			if b.Type != "toolCall" || !isTodoTool(b.Name) {
				continue
			}
			if items, ok := parseTodoArgs(b.Arguments); ok {
				last = items
			}
		}
	}
	return last
}

// toolAnswer builds a short label from a tool call's arguments.
func toolSummary(name string, raw json.RawMessage) (string, string) {
	var args map[string]any
	_ = json.Unmarshal(raw, &args)
	str := func(keys ...string) string {
		for _, k := range keys {
			if v, ok := args[k]; ok {
				if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
					return s
				}
			}
		}
		return ""
	}
	action := name
	switch name {
	case "bash":
		action = "运行"
		return action, shorten(str("command"), 120)
	case "read":
		action = "读取"
		return action, shorten(str("path", "file_path", "file"), 90)
	case "write":
		action = "写入"
		return action, shorten(str("path", "file_path", "file"), 90)
	case "edit":
		action = "编辑"
		return action, shorten(str("path", "file_path", "file"), 90)
	case "ls", "list":
		action = "列目录"
		return action, shorten(str("path", "dir"), 90)
	case "find", "glob":
		action = "查找"
		return action, shorten(strings.TrimSpace(str("pattern")+" "+str("path")), 90)
	case "grep":
		action = "搜索"
		return action, shorten(strings.TrimSpace(str("pattern")+" "+str("path")), 90)
	case "web_search", "websearch":
		action = "联网搜索"
		return action, shorten(str("query"), 90)
	case "fetch_content", "webfetch", "web_fetch":
		action = "抓取"
		return action, shorten(str("url"), 90)
	case "task", "agent", "delegate":
		action = "子代理"
		return action, shorten(str("description", "prompt"), 90)
	case "todo", "todowrite":
		action = "任务清单"
		return action, ""
	}
	for _, k := range []string{"description", "command", "path", "file_path", "query", "url", "prompt", "name"} {
		if s := str(k); s != "" {
			return action, shorten(s, 90)
		}
	}
	if len(args) > 0 {
		if compact, err := json.Marshal(args); err == nil {
			return action, shorten(string(compact), 90)
		}
	}
	return action, ""
}

// shorten trims one line of text to at most n runes.
func shorten(text string, n int) string {
	text = strings.TrimSpace(strings.SplitN(text, "\n", 2)[0])
	text = strings.Join(strings.Fields(text), " ")
	runes := []rune(text)
	if len(runes) <= n {
		return text
	}
	return string(runes[:n]) + "…"
}

// resultText reads a tool result's text, bounded for the transcript.
func resultText(r *piToolResult) string {
	if r == nil {
		return ""
	}
	text := strings.TrimSpace(r.text())
	const limit = 24_000
	if len(text) > limit {
		text = text[:limit] + "\n\n… 输出过长，已截断"
	}
	return text
}

// stepID is the stable identity of a turn's message: the same id serves
// the block while it streams and once it is committed.
func stepID(t *turn, n int) string {
	return fmt.Sprintf("%s-m%d", t.ID, n)
}
