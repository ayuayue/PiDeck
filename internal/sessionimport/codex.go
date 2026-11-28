//go:build !js && !android && !ios

package sessionimport

// OpenAI Codex CLI's rollouts: one JSONL file per session under date
// folders, whose first line names the session and the folder it ran in.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// sourceCodex reads Codex CLI's rollout files.
var Codex = &Source{
	Key: "codex", Label: "Codex CLI", Version: 2,
	Roots: func() []string { return []string{importRoot("codex", ".codex", "sessions")} },
	Scan:  scanCodex,
	Read:  readCodex,
	Sniff: sniffCodex,
}

// sniffCodex says whether a file is a Codex rollout.
func sniffCodex(head []byte) bool {
	return strings.Contains(string(head), `"type":"session_meta"`)
}

// codexLine is one rollout line.
// codexPayload is what one rollout entry carries.
type codexPayload struct {
	Type          string          `json:"type"`
	Role          string          `json:"role"`
	Cwd           string          `json:"cwd"`
	ID            string          `json:"id"`
	Model         string          `json:"model"`
	Provider      string          `json:"provider"`
	ModelProvider string          `json:"model_provider"`
	Content       json.RawMessage `json:"content"`
	Name          string          `json:"name"`
	Arguments     string          `json:"arguments"`
	Input         json.RawMessage `json:"input"`
	Output        any             `json:"output"`
	CallID        string          `json:"call_id"`
	Summary       []any           `json:"summary"`
	Message       string          `json:"message"`
	Images        json.RawMessage `json:"images"`
	IsError       bool            `json:"is_error"`
	Result        string          `json:"result"`
	Prompt        string          `json:"prompt"`
	RevisedPrompt string          `json:"revised_prompt"`
	Author        string          `json:"author"`
	Recipient     string          `json:"recipient"`
	Action        json.RawMessage `json:"action"`
	Meta          *struct {
		ContentItemKinds []string `json:"content_item_kinds"`
	} `json:"internal_chat_message_metadata_passthrough"`
}

// codexLine is one line of a rollout.
type codexLine struct {
	Timestamp string       `json:"timestamp"`
	Type      string       `json:"type"`
	Payload   codexPayload `json:"payload"`
}

// scanCodex lists the rollouts under one root.
func scanCodex(root string) ([]Candidate, error) {
	names := codexIndex(root)
	var files []string
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if d.Name() == "rollouts" {
				return filepath.SkipDir // agent traces, not sessions
			}
			return nil
		}
		if !strings.HasSuffix(strings.ToLower(d.Name()), ".jsonl") {
			return nil
		}
		files = append(files, path)
		return nil
	})
	return scanHeads(files, func(path string) (Candidate, bool) {
		info, err := os.Stat(path)
		if err != nil {
			return Candidate{}, false
		}
		f, err := os.Open(path)
		if err != nil {
			return Candidate{}, false
		}
		defer f.Close()
		sc := bufio.NewScanner(io.LimitReader(f, 1<<20))
		sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
		var cand Candidate
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" {
				continue
			}
			var e codexLine
			if json.Unmarshal([]byte(line), &e) != nil {
				continue
			}
			at := codexTime(e.Timestamp)
			if at.After(cand.Updated) {
				cand.Updated = at
			}
			switch {
			case e.Type == "session_meta":
				cand.ID = e.Payload.ID
				cand.Cwd = e.Payload.Cwd
				if cand.ID == "" {
					cand.ID = codexSessionIDFromName(path)
				}
			case e.Type == "turn_context" && cand.Cwd == "":
				cand.Cwd = e.Payload.Cwd
			case e.Type == "response_item" && e.Payload.Type == "message" && e.Payload.Role == "user":
				cand.Count++
				if text := codexUserText(e.Payload.Content); text != "" && cand.Title == "" {
					cand.Title = titleLine(text, 60)
				}
			case e.Type == "response_item" && e.Payload.Type == "message":
				cand.Count++
			}
		}
		if cand.ID == "" {
			return Candidate{}, false
		}
		if name := names[cand.ID]; name != "" {
			cand.Title = importTitle(name)
		}
		cand.Source = "codex"
		cand.Path = path
		cand.Size, cand.MTime = info.Size(), info.ModTime()
		if cand.Updated.IsZero() {
			cand.Updated = info.ModTime()
		}
		return cand, true
	}), nil
}

// codexSessionIDFromName reads the id a rollout file name carries, which is
// what a file whose header is lost still has.
func codexSessionIDFromName(path string) string {
	base := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	parts := strings.Split(base, "-")
	// rollout-2026-03-05T11-34-40-<uuid>
	if len(parts) >= 8 {
		return strings.Join(parts[len(parts)-5:], "-")
	}
	return ""
}

// codexTime reads a rollout timestamp.
func codexTime(v string) time.Time {
	tv := importTime(v)
	if !tv.ok {
		return time.Time{}
	}
	return tv.time
}

// codexMessageText joins a message's text items.
func codexMessageText(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var items []map[string]any
	if json.Unmarshal(raw, &items) != nil {
		return ""
	}
	var parts []string
	for _, item := range items {
		switch asString(item["type"]) {
		case "input_text", "output_text", "text", "summary_text":
			if t := strings.TrimSpace(asString(item["text"])); t != "" {
				parts = append(parts, t)
			}
		}
	}
	return strings.Join(parts, "\n")
}

// readCodex converts one rollout into pi's terms. Codex writes one entry
// per content piece (a message, a reasoning line, a tool call), and pi keeps
// a turn whole, so consecutive assistant entries are merged; a tool result
// ends the run and follows it.
func readCodex(path string) (Session, error) {
	f, err := os.Open(path)
	if err != nil {
		return Session{}, err
	}
	defer f.Close()
	out := Session{}
	names := map[string]string{}
	pending := map[string]bool{}
	var thinking []string
	var buf []Block
	var calls []string
	var bufAt time.Time
	var bufModel, bufProvider string

	flush := func() {
		if len(thinking) > 0 {
			buf = append([]Block{{Kind: "thinking", Thinking: strings.Join(thinking, "\n\n")}}, buf...)
			thinking = nil
		}
		if len(buf) == 0 {
			return
		}
		out.Messages = append(out.Messages, Message{Role: "assistant", Timestamp: bufAt, Blocks: buf,
			Provider: orDefault(bufProvider, "codex"), Model: orDefault(bufModel, "codex"),
			StopReason: importStopReason("", len(calls) > 0)})
		for _, id := range calls {
			pending[id] = true
		}
		buf, calls = nil, nil
		bufAt = time.Time{}
		bufModel, bufProvider = "", ""
	}
	addCall := func(id, name string, args json.RawMessage, at time.Time) string {
		if id == "" {
			id = importToken(name + at.String())
		}
		if bufAt.IsZero() {
			bufAt = at
		}
		buf = append(buf, Block{Kind: "toolCall", ID: id, Name: name, Arguments: args})
		calls = append(calls, id)
		names[id] = name
		return id
	}
	result := func(id, name, text string, isError bool, at time.Time) {
		if id != "" && pending[id] {
			delete(pending, id)
			out.Messages = append(out.Messages, Message{Role: "toolResult", Text: text, Timestamp: at,
				ToolCallID: id, ToolName: orDefault(names[id], orDefault(name, "tool")), IsError: isError})
			return
		}
		if strings.TrimSpace(text) == "" {
			return
		}
		// The call is gone: keep what the tool said rather than lose it.
		out.Messages = append(out.Messages, Message{Role: "user", Timestamp: at, Blocks: []Block{{
			Kind: "text", Text: "[" + orDefault(name, "tool") + " result, detached from its tool call in the source transcript, kept as text]\n" + text,
		}}})
	}

	sc := newImportScanner(f)
	for sc.Scan() {
		line := sc.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		var e codexLine
		if json.Unmarshal(line, &e) != nil {
			continue
		}
		at := codexTime(e.Timestamp)
		if out.Updated.Before(at) {
			out.Updated = at
		}
		if e.Type == "session_meta" {
			out.Cwd = e.Payload.Cwd
			bufProvider = firstNonEmpty(e.Payload.Provider, e.Payload.ModelProvider)
			bufModel = e.Payload.Model
			continue
		}
		if e.Type != "response_item" {
			continue
		}
		switch e.Payload.Type {
		case "message":
			switch e.Payload.Role {
			case "user":
				text, images := codexUserBlocks(e.Payload)
				flush()
				if text == "" && len(images) == 0 {
					continue
				}
				blocks := make([]Block, 0, len(images)+1)
				if text != "" {
					blocks = append(blocks, Block{Kind: "text", Text: text})
				}
				blocks = append(blocks, images...)
				out.Messages = append(out.Messages, Message{Role: "user", Timestamp: at, Blocks: blocks})
				if out.Title == "" && text != "" {
					out.Title = titleLine(text, 60)
				}
			case "assistant":
				blocks := codexBlocks(e.Payload.Content, "assistant")
				if len(blocks) == 0 {
					continue
				}
				if bufAt.IsZero() {
					bufAt = at
				}
				bufModel = firstNonEmpty(e.Payload.Model, bufModel)
				bufProvider = firstNonEmpty(e.Payload.Provider, bufProvider)
				buf = append(buf, blocks...)
			}
		case "reasoning":
			text := codexMessageText(e.Payload.Content)
			if strings.TrimSpace(text) == "" {
				text = codexSummaryText(e.Payload.Summary)
			}
			if strings.TrimSpace(text) != "" {
				if bufAt.IsZero() {
					bufAt = at
				}
				thinking = append(thinking, text)
			}
		case "function_call":
			addCall(firstNonEmpty(e.Payload.CallID, e.Payload.ID), orDefault(e.Payload.Name, "tool"),
				importArguments(e.Payload.Arguments), at)
		case "custom_tool_call":
			addCall(firstNonEmpty(e.Payload.CallID, e.Payload.ID), orDefault(e.Payload.Name, "tool"),
				codexCustomArguments(e.Payload.Input), at)
		case "local_shell_call":
			addCall(firstNonEmpty(e.Payload.CallID, e.Payload.ID), orDefault(e.Payload.Name, "shell"),
				importArguments(e.Payload.Arguments), at)
		case "web_search_call":
			id := addCall(firstNonEmpty(e.Payload.CallID, e.Payload.ID), "web_search", codexSearchArguments(e.Payload.Action), at)
			flush()
			result(id, "web_search", "（Codex 未在会话文件中保存联网检索结果正文）", false, at)
		case "tool_search_call":
			addCall(firstNonEmpty(e.Payload.CallID, e.Payload.ID), "tool_search",
				importArguments(e.Payload.Arguments), at)
		case "image_generation_call":
			args := importArguments(map[string]any{"prompt": firstNonEmpty(e.Payload.RevisedPrompt, e.Payload.Prompt)})
			id := addCall(firstNonEmpty(e.Payload.CallID, e.Payload.ID), "image_generation", args, at)
			flush()
			result(id, "image_generation", codexGeneratedImage(e.Payload.Result), false, at)
		case "agent_message":
			id := addCall(firstNonEmpty(e.Payload.CallID, e.Payload.ID), "agent_message",
				importArguments(map[string]any{"author": e.Payload.Author, "recipient": e.Payload.Recipient}), at)
			if text := codexMessageText(e.Payload.Content); strings.TrimSpace(text) != "" {
				flush()
				result(id, "agent_message", text, false, at)
			}
		case "function_call_output", "custom_tool_call_output", "local_shell_call_output":
			id := firstNonEmpty(e.Payload.CallID, e.Payload.ID)
			flush()
			result(id, "tool", importToolOutput(e.Payload.Output), e.Payload.IsError, at)
		case "tool_search_output":
			flush()
			result(firstNonEmpty(e.Payload.CallID, e.Payload.ID), "tool_search",
				codexToolSearchText(e.Payload.Output), false, at)
		}
	}
	flush()
	if len(thinking) > 0 {
		out.Messages = append(out.Messages, Message{Role: "assistant", Timestamp: out.Updated,
			Blocks:   []Block{{Kind: "thinking", Thinking: strings.Join(thinking, "\n\n")}},
			Provider: "codex", Model: "codex", StopReason: "stop"})
	}
	if out.Cwd == "" {
		if cand, ok := codexHeadOf(path); ok {
			out.Cwd = cand.Cwd
		}
	}
	if out.Title == "" {
		out.Title = codexDateTitle(out.Updated)
	}
	out.Messages = repairToolResults(out.Messages)
	return out, sc.Err()
}

// codexScaffoldTags are the wrappers Codex writes around context it gives
// itself; none of it is something the user said.
var codexScaffoldTags = []string{"recommended_plugins", "environment_context",
	"permissions[_-]?instructions", "user_instructions", "app[_-]?context",
	"codex_internal_context", "turn_aborted", "INSTRUCTIONS", "send_user_message_question_reply"}

// codexScaffoldBlocks matches one wrapped block of each tag: Go's regexp has
// no backreferences, so each tag gets its own pattern.
var codexScaffoldBlocks = func() []*regexp.Regexp {
	var out []*regexp.Regexp
	for _, tag := range codexScaffoldTags {
		out = append(out, regexp.MustCompile(`(?s)<`+tag+`[^>]*>.*?</`+tag+`>`))
	}
	return out
}()

// codexScaffoldTag matches a stray open or close tag of any of them.
var codexScaffoldTag = regexp.MustCompile(`</?(?:` + strings.Join(codexScaffoldTags, "|") + `)[^>]*>`)

// codexScaffoldPrefixes are the lines that say the text is context, not the
// user's words.
var codexScaffoldPrefixes = []string{
	"# AGENTS.md instructions", "# In app browser:", "# Response annotations:",
	"## Code review guidelines:", "The following is the Codex agent history",
	"[Request interrupted by user", "<command-name>", "<send_user_message_question_reply>",
}

// codexRequestMark is where the user's own words start, inside a message
// that also carries context.
const codexRequestMark = "## My request:"

// codexSanitize drops Codex's own scaffolding from a user message, and
// returns "" when nothing the user wrote is left.
func codexSanitize(text string) string {
	for _, block := range codexScaffoldBlocks {
		text = block.ReplaceAllString(text, "")
	}
	text = codexScaffoldTag.ReplaceAllString(text, "")
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	if i := strings.Index(text, codexRequestMark); i >= 0 {
		text = strings.TrimSpace(text[i+len(codexRequestMark):])
	}
	for _, prefix := range codexScaffoldPrefixes {
		if strings.HasPrefix(text, prefix) {
			return ""
		}
	}
	if strings.HasPrefix(text, "# Files pasted by the user:") || strings.HasPrefix(text, "# Files mentioned by the user:") {
		return ""
	}
	return text
}

// codexUserBlocks is a user message's words and pictures.
func codexUserBlocks(p codexPayload) (string, []Block) {
	// Codex marks what a message carries; when it says there is no user
	// text, the message is context only.
	if p.Meta != nil && len(p.Meta.ContentItemKinds) > 0 {
		found := false
		for _, kind := range p.Meta.ContentItemKinds {
			if kind == "user.text" {
				found = true
			}
		}
		if !found {
			return "", nil
		}
	}
	var texts []string
	var images []Block
	addImages := func(raw json.RawMessage) {
		var items []map[string]any
		if json.Unmarshal(raw, &items) != nil {
			return
		}
		for _, item := range items {
			if b := codexImageBlock(item); b != nil {
				images = append(images, *b)
			}
		}
	}
	var items []map[string]any
	if json.Unmarshal(p.Content, &items) == nil {
		for _, item := range items {
			kind := asString(item["type"])
			if kind == "input_image" || kind == "image" || kind == "file" {
				if b := codexImageBlock(item); b != nil {
					images = append(images, *b)
				}
				continue
			}
			if text := strings.TrimSpace(asString(item["text"])); text != "" {
				texts = append(texts, text)
			}
		}
	} else {
		var text string
		if json.Unmarshal(p.Content, &text) == nil {
			texts = append(texts, text)
		}
	}
	addImages(p.Images)
	return codexSanitize(strings.Join(texts, "\n")), images
}

// codexImageBlock reads an image-shaped content item.
func codexImageBlock(item map[string]any) *Block {
	kind := asString(item["type"])
	mime := firstNonEmpty(asString(item["mime_type"]), asString(item["mimeType"]))
	if kind == "file" && !strings.HasPrefix(mime, "image/") {
		return nil
	}
	label := firstNonEmpty(asString(item["filename"]), asString(item["name"]), asString(item["url"]))
	data := asString(item["data"])
	if data == "" {
		if src := asMap(item["source"]); src != nil {
			data = asString(src["data"])
			mime = firstNonEmpty(mime, asString(src["media_type"]), asString(src["mimeType"]))
		}
	}
	if data == "" {
		data = asString(item["image_url"])
	}
	if data == "" {
		data = asString(item["url"])
	}
	b := importImageBlock(data, mime, label)
	return &b
}

// codexCustomArguments reads a custom tool call's input, which may be a
// JSON object or a bare patch body.
func codexCustomArguments(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("{}")
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) == nil {
		return importArguments(obj)
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		if strings.HasPrefix(strings.TrimSpace(text), "{") {
			var inner map[string]any
			if json.Unmarshal([]byte(text), &inner) == nil {
				return importArguments(inner)
			}
		}
		return importArguments(map[string]any{"input": text})
	}
	return importArguments(raw)
}

// codexSearchArguments reads what a web search asked for.
func codexSearchArguments(raw json.RawMessage) json.RawMessage {
	var action map[string]any
	if json.Unmarshal(raw, &action) != nil {
		return json.RawMessage("{}")
	}
	args := map[string]any{}
	for _, key := range []string{"query", "queries"} {
		if v, ok := action[key]; ok && v != nil {
			args[key] = v
		}
	}
	return importArguments(args)
}

// codexGeneratedImage is what an image generation left behind.
func codexGeneratedImage(result string) string {
	data := stripDataURL(result)
	if data == "" {
		return "（Codex 没有把生成的图片留在会话文件里）"
	}
	if len(data) > importImageMax {
		return "[image: generated]"
	}
	return "（生成了一张图片，见会话附件）"
}

// codexToolSearchText names the tools a search matched.
func codexToolSearchText(output any) string {
	var items []any
	switch v := output.(type) {
	case []any:
		items = v
	case map[string]any:
		if list, ok := v["tools"].([]any); ok {
			items = list
		}
	}
	if len(items) == 0 {
		return "（无匹配工具）"
	}
	lines := []string{fmt.Sprintf("匹配到 %d 个工具：", len(items))}
	for _, item := range items {
		switch v := item.(type) {
		case string:
			lines = append(lines, "- "+v)
		case map[string]any:
			name := firstNonEmpty(asString(v["name"]), asString(v["namespace"]))
			if name != "" {
				lines = append(lines, "- "+name)
			}
		}
	}
	return strings.Join(lines, "\n")
}

// codexDateTitle names a session the index does not know.
func codexDateTitle(at time.Time) string {
	if at.IsZero() {
		return "Codex 会话"
	}
	return "Codex 会话 " + at.Format("2006-01-02")
}

// codexSummaryText joins a reasoning entry's summary lines.
func codexSummaryText(items []any) string {
	var parts []string
	for _, item := range items {
		if m := asMap(item); m != nil {
			if t := strings.TrimSpace(asString(m["text"])); t != "" {
				parts = append(parts, t)
			}
		}
	}
	return strings.Join(parts, "\n")
}

// codexBlocks maps a message's content items.
func codexBlocks(raw json.RawMessage, role string) []Block {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		if strings.TrimSpace(text) == "" {
			return nil
		}
		return []Block{{Kind: "text", Text: text}}
	}
	var items []map[string]any
	if json.Unmarshal(raw, &items) != nil {
		return nil
	}
	var blocks []Block
	for _, item := range items {
		switch asString(item["type"]) {
		case "input_text", "output_text", "text":
			if t := asString(item["text"]); t != "" {
				blocks = append(blocks, Block{Kind: "text", Text: t})
			}
		case "input_image", "image":
			blocks = append(blocks, importImageBlock(asString(item["image_url"]), asString(item["mime_type"]),
				asString(item["filename"])))
		case "refusal":
			if t := asString(item["refusal"]); t != "" {
				blocks = append(blocks, Block{Kind: "text", Text: t})
			}
		}
	}
	return blocks
}

// codexHeadOf reads a rollout's header for its folder.
func codexHeadOf(path string) (Candidate, bool) {
	f, err := os.Open(path)
	if err != nil {
		return Candidate{}, false
	}
	defer f.Close()
	sc := bufio.NewScanner(io.LimitReader(f, 64<<10))
	sc.Buffer(make([]byte, 0, 8<<10), 1<<20)
	for i := 0; i < 8 && sc.Scan(); i++ {
		var e codexLine
		if json.Unmarshal(sc.Bytes(), &e) == nil && e.Type == "session_meta" {
			return Candidate{ID: e.Payload.ID, Cwd: e.Payload.Cwd}, true
		}
	}
	return Candidate{}, false
}

// codexIndex reads Codex's own name index: a rollout carries no title, and
// the app keeps one line per session, appended again when it is renamed.
func codexIndex(root string) map[string]string {
	names := map[string]string{}
	path := filepath.Join(filepath.Dir(root), "session_index.jsonl")
	f, err := os.Open(path)
	if err != nil {
		return names
	}
	defer f.Close()
	sc := bufio.NewScanner(io.LimitReader(f, 8<<20))
	sc.Buffer(make([]byte, 0, 64<<10), 2<<20)
	for sc.Scan() {
		var entry struct {
			ID   string `json:"id"`
			Name string `json:"thread_name"`
		}
		if json.Unmarshal(sc.Bytes(), &entry) == nil && entry.ID != "" && entry.Name != "" {
			names[entry.ID] = entry.Name
		}
	}
	return names
}

// codexUserText is the user's own words from a message, with Codex's
// scaffolding dropped: the environment block and the instruction header are
// not something the user said.
func codexUserText(raw json.RawMessage) string {
	var items []map[string]any
	if json.Unmarshal(raw, &items) != nil {
		return ""
	}
	var parts []string
	for _, item := range items {
		kind := asString(item["type"])
		if kind != "input_text" && kind != "text" {
			continue
		}
		if text := strings.TrimSpace(asString(item["text"])); text != "" {
			parts = append(parts, text)
		}
	}
	return codexSanitize(strings.Join(parts, "\n"))
}
