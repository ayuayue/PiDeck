//go:build !js && !android && !ios

package workbench

// The data the screen reads: sessions, turns, tool runs, models and usage.

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"example.com/pideck-v2/internal/remotewire"
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
	Images []remotewire.Image `json:",omitempty"`
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
	// TextAt is how many tool calls came before the prose, so the step reads
	// in the order pi wrote it: prose, calls, or calls and then prose.
	TextAt int
	Start  time.Time
}

// turn is one request and everything pi did for it.
type turn struct {
	ID            string
	sourceEntryID string
	sourcePrompt  string
	Prompt        string
	Images        []remotewire.Image
	Status        chat.Status
	Start         time.Time
	End           time.Time
	Steps         []turnStep
	Final         string
	Err           string
	Usage         usageInfo
	Tools         int
	// Model is the model that answered this turn, as pi names it.
	Model   string
	Msgs    int    // messages committed, for the next step's ID
	Noticed string // a live status note, such as a retry
	// Plan marks a turn that asked for a plan first; its answer is a
	// plan the user can execute or edit. Goal marks a turn of a goal that
	// carries itself on.
	Plan bool
	Goal bool
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

// replyPerf is the last reply's pace and the session's cache-hit record:
// the ring and its panel show both, and pi reports neither.
type replyPerf struct {
	TTFT   time.Duration // the first token, from the request
	Total  time.Duration // the whole reply
	Output int           // the tokens it wrote
	// LastPrompt is the last message's tokens: what the context held when it
	// answered, the fallback when pi has no context count yet.
	LastPrompt int
	// HitLast is the last reply's cached share of its prompt, and HitSum
	// with HitCount average it over the session, as pi's footer does.
	HitLast       float64
	HitSum        float64
	HitCount      int
	HasHit        bool
	HasTTFT       bool
	HasReplySpeed bool
}

// rate is the reply's tokens a second, 0 when it is unknown.
func (p replyPerf) rate() float64 {
	if !p.HasReplySpeed || p.Total <= 0 || p.Output <= 0 {
		return 0
	}
	return float64(p.Output) / p.Total.Seconds()
}

// averageHit is the session's mean cache-hit share, -1 when it has none.
func (p replyPerf) averageHit() float64 {
	if p.HitCount <= 0 {
		return -1
	}
	return p.HitSum / float64(p.HitCount)
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

// extensionAsk is an extension dialog waiting for the user. A batch ask
// carries the questions the extension packed into one input request;
// Answers is how far the card got before it was answered or closed.
type extensionAsk struct {
	ID      string
	Method  string // select, confirm, input, editor, batch_ask
	Title   string
	Message string
	Options []string
	Default string
	Timeout time.Duration
	// Choices are rich options: label, value and a line of description.
	// They come from the batch envelope and from selects the extension
	// wrote with a description; Options stays the label list the phone
	// shows.
	Choices     []askOption
	AllowOther  bool
	Placeholder string
	Questions   []askQuestion
	Review      bool
	ACPReply    func(string)
	// PlanNext marks PiDeck's post-plan select: choosing "start" returns the
	// composer from plan mode to normal.
	PlanNext bool
}

// todoItem is one line of the agent's task list, as its todo tool reports
// it. The bar above the composer shows these; the statuses are the ones
// the tools use, normalized.
type todoItem struct {
	// ID is the tool's own id for the item, which later calls address it
	// by; items a tool never numbered keep the number they were read at.
	ID     string
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

// todoTextKeys are the field names tools give a task's words, in the order
// a call is read: the ones the agent's own tools use first.
var todoTextKeys = []string{"content", "text", "subject", "title", "task", "step", "description", "name", "label", "activeForm", "active_form"}

// todoIDKeys are the field names tools give a task's id.
var todoIDKeys = []string{"id", "todoId", "todo_id", "taskId", "task_id", "itemId", "item_id"}

// todoListKeys are the fields that hold a whole list.
var todoListKeys = []string{"todos", "items", "tasks", "list", "plan", "steps"}

// parseTodoArgs reads a whole task list out of a tool call. Tools name the
// list and its fields differently, so it looks for the common shapes rather
// than one schema. Items a tool did not give ids are numbered from 1, which
// is how those tools address them in later calls.
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
		for _, key := range todoListKeys {
			v, ok := args[key]
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
		text := todoStringField(obj, todoTextKeys)
		if text == "" {
			continue
		}
		out = append(out, todoItem{ID: idField(obj), Text: text, Status: statusField(obj)})
	}
	if len(out) == 0 {
		return nil, false
	}
	for i := range out {
		if out[i].ID == "" {
			out[i].ID = fmt.Sprint(i + 1)
		}
	}
	return out, true
}

// applyTodoArgs folds one todo tool call into the list it leaves. A call
// that carries the whole list replaces it; a call that carries an action on
// an id patches that item, which is how most tools keep a plan — they create
// one task at a time and then mark ids done, never sending the list again.
func applyTodoArgs(current []todoItem, raw json.RawMessage) ([]todoItem, bool) {
	if items, ok := parseTodoArgs(raw); ok {
		return items, true
	}
	var args map[string]any
	if json.Unmarshal(raw, &args) != nil {
		return current, false
	}
	action := strings.ToLower(strings.TrimSpace(todoStringField(args, []string{"action", "op", "operation", "type", "command"})))
	id := idField(args)
	text := todoStringField(args, todoTextKeys)
	status := statusField(args)
	explicit := false
	if _, ok := args["status"].(string); ok {
		explicit = true
	} else if _, ok := args["done"].(bool); ok {
		explicit = true
	} else if _, ok := args["completed"].(bool); ok {
		explicit = true
	}
	switch action {
	case "create", "add", "append", "new", "insert":
		if text == "" {
			return current, false
		}
		if !explicit {
			status = "pending"
		}
		if id == "" {
			id = nextTodoID(current)
		}
		return append(append([]todoItem(nil), current...), todoItem{ID: id, Text: text, Status: status}), true
	case "update", "patch", "edit", "set", "rename", "start", "begin", "complete", "finish", "done", "cancel",
		"in_progress", "reopen", "reset":
		if id == "" {
			return current, false
		}
		// Some tools spell the change as the action itself.
		switch action {
		case "start", "begin", "in_progress":
			status, explicit = "in_progress", true
		case "complete", "finish", "done":
			status, explicit = "completed", true
		case "cancel":
			status, explicit = "cancelled", true
		}
		if text == "" && !explicit {
			return current, false
		}
		next := append([]todoItem(nil), current...)
		found := false
		for i := range next {
			if next[i].ID != id {
				continue
			}
			found = true
			if text != "" {
				next[i].Text = text
			}
			if explicit {
				next[i].Status = status
			}
		}
		return next, found
	case "delete", "remove", "drop":
		if id == "" {
			return current, false
		}
		next := make([]todoItem, 0, len(current))
		found := false
		for _, it := range current {
			if it.ID == id {
				found = true
				continue
			}
			next = append(next, it)
		}
		return next, found
	case "clear", "reset_plan", "remove_all":
		return nil, true
	}
	// No action word: a call with an id and a state is an update.
	if id != "" && explicit {
		return applyTodoArgs(current, mustJSON(map[string]any{"action": "update", "id": id, "status": status}))
	}
	return current, false
}

// nextTodoID numbers a task a tool created without an id, past the numbers
// the list already uses.
func nextTodoID(items []todoItem) string {
	highest := 0
	for _, it := range items {
		if n, err := strconv.Atoi(it.ID); err == nil && n > highest {
			highest = n
		}
	}
	return strconv.Itoa(highest + 1)
}

// mustJSON re-encodes a call the reduction above can read.
func mustJSON(value map[string]any) json.RawMessage {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return raw
}

// todoStringField returns the first non-empty string among keys.
func todoStringField(obj map[string]any, keys []string) string {
	for _, key := range keys {
		if s, ok := obj[key].(string); ok && strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

// idField returns the task's id as text, "" when it has none.
func idField(obj map[string]any) string {
	for _, key := range todoIDKeys {
		switch v := obj[key].(type) {
		case string:
			if s := strings.TrimSpace(v); s != "" {
				return s
			}
		case float64:
			return fmt.Sprint(int64(v))
		}
	}
	return ""
}

// statusField reads a task's state from the words tools use for it.
func statusField(obj map[string]any) string {
	if s, ok := obj["status"].(string); ok && strings.TrimSpace(s) != "" {
		return normalizeTodoStatus(s)
	}
	if done, ok := obj["done"].(bool); ok {
		if done {
			return "completed"
		}
		return "pending"
	}
	if done, ok := obj["completed"].(bool); ok {
		if done {
			return "completed"
		}
		return "pending"
	}
	return "pending"
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

// todoPlanLine matches the line a todo tool writes its plan as: PiDeck's own
// tool appends the whole plan to every result, "[status] #id: text".
var todoPlanLine = regexp.MustCompile(`^\[(pending|in_progress|completed|cancelled)\] #(\S+): (.+)$`)

// todoPlanFromText reads the plan a todo tool's result spells out. A tool
// that answers each change with the whole plan leaves the newest list there,
// whatever its calls looked like.
func todoPlanFromText(text string) ([]todoItem, bool) {
	var out []todoItem
	for _, line := range strings.Split(text, "\n") {
		m := todoPlanLine.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil {
			continue
		}
		out = append(out, todoItem{ID: m[2], Text: strings.TrimSpace(m[3]), Status: m[1]})
	}
	return out, len(out) > 0
}

// todosFromMessages replays pi's history to the task list it ends with:
// every todo call folded in order, and every plan a result spelled out.
func todosFromMessages(msgs []piMessage) []todoItem {
	var items []todoItem
	for _, m := range msgs {
		if m.Role == "assistant" {
			for _, b := range m.blocks() {
				if b.Type != "toolCall" || !isTodoTool(b.Name) {
					continue
				}
				if next, ok := applyTodoArgs(items, b.Arguments); ok {
					items = next
				}
			}
			continue
		}
		if !isTodoTool(m.ToolName) {
			continue
		}
		if plan, ok := todoPlanFromText(piBlockText(m.blocks())); ok {
			items = plan
		}
	}
	return items
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
	case "task", "agent", "Agent", "delegate", "acp_delegate", "subagent":
		if name == "subagent" {
			if str("workflowScript", "workflowScriptPath") != "" {
				return "工作流", shorten(str("workflowScriptPath", "description", "task", "workflowScript"), 120)
			}
			if str("action") != "" {
				break
			}
		}
		action = "子代理"
		return action, shorten(strings.Trim(strings.Join([]string{str("agent", "subagent_type"), str("task", "description", "prompt")}, " · "), " ·"), 120)
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
