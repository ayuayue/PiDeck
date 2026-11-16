//go:build !js && !android && !ios

package main

// WorkBuddy and CodeBuddy keep their transcripts the same way: one folder
// per project, one JSONL per session, with reasoning and tool calls as
// entries of their own rather than blocks inside a message.

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

// familyTool is one of the two tools of this shape.
type familyTool struct {
	key      string
	label    string
	home     string
	provider string
}

// familyTools are the tools this shape covers.
var (
	familyWorkBuddy = familyTool{key: "workbuddy", label: "WorkBuddy", home: ".workbuddy", provider: "workbuddy"}
	familyCodeBuddy = familyTool{key: "codebuddy", label: "CodeBuddy", home: ".codebuddy", provider: "codebuddy"}
)

// sourceWorkBuddy reads WorkBuddy's projects.
var sourceWorkBuddy = familySource(familyWorkBuddy)

// sourceCodeBuddy reads CodeBuddy's projects.
var sourceCodeBuddy = familySource(familyCodeBuddy)

// familySource builds the import source for one tool of this shape.
func familySource(t familyTool) *importSource {
	return &importSource{
		Key: t.key, Label: t.label, Version: 1,
		Roots: func() []string { return []string{importRoot(t.key, t.home, "projects")} },
		Scan:  func(root string) ([]importCandidate, error) { return scanFamily(root, t) },
		Read:  func(path string) (importedSession, error) { return readFamily(path, t) },
		Sniff: func(head []byte) bool {
			return strings.Contains(string(head), `"__codebuddyLocal"`) || strings.Contains(string(head), `"ai-title"`)
		},
	}
}

// injectedBlocks are the wrappers these tools put around a user's words.
var (
	injectedReminder = regexp.MustCompile(`(?s)<system-reminder>.*?</system-reminder>`)
	injectedSelfTag  = regexp.MustCompile(`<system-reminder\s*/>`)
	userQueryTag     = regexp.MustCompile(`</?user_query>`)
)

// stripInjected removes the context a tool injects into the user's message.
func stripInjected(text string) string {
	text = injectedReminder.ReplaceAllString(text, "")
	text = injectedSelfTag.ReplaceAllString(text, "")
	text = userQueryTag.ReplaceAllString(text, "")
	return strings.TrimSpace(text)
}

// scanFamily lists the sessions under one projects folder.
func scanFamily(root string, t familyTool) ([]importCandidate, error) {
	files := familyFiles(root)
	return scanHeads(files, func(path string) (importCandidate, bool) {
		return readFamilyCandidate(path, root, t)
	}), nil
}

// readFamilyCandidate reads one session's head for the list.
func readFamilyCandidate(path, root string, t familyTool) (importCandidate, bool) {
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
	var first, last time.Time
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
		if at := familyTime(rec); !at.IsZero() {
			if first.IsZero() || at.Before(first) {
				first = at
			}
			if at.After(last) {
				last = at
			}
		}
		switch asString(rec["type"]) {
		case "message":
			role := asString(rec["role"])
			if role != "user" && role != "assistant" {
				continue
			}
			cand.Count++
			if cand.ID == "" {
				cand.ID = asString(rec["sessionId"])
				if cand.Cwd == "" {
					cand.Cwd = asString(rec["cwd"])
				}
			}
			if role == "user" && cand.Title == "" {
				text := stripInjected(familyText(rec["content"]))
				if text != "" && !strings.HasPrefix(text, "<") {
					cand.Title = firstLine(text, 60)
				}
			}
		case "ai-title":
			if cand.Title == "" {
				cand.Title = importTitle(asString(rec["aiTitle"]))
			}
		}
	}
	if cand.ID == "" {
		cand.ID = strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	}
	if cand.Count == 0 {
		return importCandidate{}, false
	}
	if cand.Cwd == "" {
		if slug := familySlugOf(path, root); slug != "" {
			cand.Cwd = familySlugPath(slug)
		}
	}
	if last.IsZero() {
		last = info.ModTime()
	}
	cand.Source = t.key
	cand.Path = path
	cand.Updated = last
	cand.Size, cand.MTime = info.Size(), info.ModTime()
	return cand, true
}

// familyTime reads a record's timestamp.
func familyTime(rec map[string]any) time.Time {
	for _, key := range []string{"timestamp", "created_at", "createdAt", "updated_at"} {
		if tv := importTime(rec[key]); tv.ok {
			return tv.time
		}
	}
	return time.Time{}
}

// familyText joins a record's text items.
func familyText(v any) string {
	switch v := v.(type) {
	case string:
		return v
	case []any:
		var parts []string
		for _, item := range v {
			switch b := item.(type) {
			case string:
				parts = append(parts, b)
			case map[string]any:
				if t := asString(b["text"]); t != "" {
					parts = append(parts, t)
				}
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

// familyModel reads the model a record names.
func familyModel(rec map[string]any) string {
	if data := asMap(rec["providerData"]); data != nil {
		if m := asString(data["model"]); m != "" {
			return m
		}
	}
	for _, key := range []string{"requestModelId", "requestModelName"} {
		if m := asString(rec[key]); m != "" {
			return m
		}
	}
	return ""
}

// readFamily converts one session into pi's terms.
func readFamily(path string, t familyTool) (importedSession, error) {
	f, err := os.Open(path)
	if err != nil {
		return importedSession{}, err
	}
	defer f.Close()
	out := importedSession{}
	if cwd := readFamilyCwd(path); cwd != "" {
		out.Cwd = cwd
	}
	// Reasoning and tool calls arrive as entries of their own; they belong
	// to the assistant turn being written, so they wait for it.
	var pending []importBlock
	var pendingCalls []string
	var pendingAt time.Time
	var pendingModel string
	flush := func() {
		if len(pending) == 0 {
			pending, pendingCalls = nil, nil
			pendingModel = ""
			return
		}
		out.Messages = append(out.Messages, importMessage{Role: "assistant", Blocks: pending, Timestamp: pendingAt,
			Provider: t.provider, Model: orDefault(pendingModel, t.provider+"-import"),
			StopReason: importStopReason("", len(pendingCalls) > 0)})
		pending, pendingCalls = nil, nil
		pendingModel = ""
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
		at := familyTime(rec)
		if out.Updated.Before(at) {
			out.Updated = at
		}
		switch asString(rec["type"]) {
		case "reasoning":
			text := familyText(rec["rawContent"])
			if text == "" {
				text = familyText(rec["content"])
			}
			if strings.TrimSpace(text) == "" {
				continue
			}
			if pendingAt.IsZero() {
				pendingAt = at
			}
			pending = append(pending, importBlock{Kind: "thinking", Thinking: text})
		case "function_call":
			call := importToolCall{ID: asString(rec["callId"]), Name: asString(rec["name"])}
			if call.ID == "" {
				call.ID = importToken(t.key + "-" + call.Name)
			}
			if pendingAt.IsZero() {
				pendingAt = at
			}
			pending = append(pending, importBlock{Kind: "toolCall", ID: call.ID, Name: call.Name,
				Arguments: importArguments(rec["arguments"])})
			pendingCalls = append(pendingCalls, call.ID)
			if m := familyModel(rec); m != "" {
				pendingModel = m
			}
		case "function_call_result":
			flush()
			id := asString(rec["callId"])
			text := ""
			switch v := rec["output"].(type) {
			case string:
				text = v
			case map[string]any:
				text = asString(v["text"])
				if text == "" {
					text = importToolOutput(v["content"])
				}
			default:
				text = importToolOutput(rec["output"])
			}
			status := asString(rec["status"])
			out.Messages = append(out.Messages, importMessage{Role: "toolResult", Text: text, Timestamp: at,
				ToolCallID: id, ToolName: orDefault(asString(rec["name"]), "tool"), IsError: status != "" && status != "completed"})
		case "message":
			flush()
			role := asString(rec["role"])
			if role != "user" && role != "assistant" {
				continue
			}
			text := familyText(rec["content"])
			if role == "user" {
				text = stripInjected(text)
			}
			if strings.TrimSpace(text) == "" {
				continue
			}
			msg := importMessage{Role: role, Timestamp: at, Blocks: []importBlock{{Kind: "text", Text: text}}}
			if role == "assistant" {
				msg.Provider = t.provider
				msg.Model = orDefault(familyModel(rec), t.provider+"-import")
				msg.StopReason = "stop"
			} else if out.Title == "" && !strings.HasPrefix(strings.TrimSpace(text), "<") {
				out.Title = firstLine(text, 60)
			}
			out.Messages = append(out.Messages, msg)
		}
	}
	flush()
	out.Messages = repairToolResults(out.Messages)
	return out, sc.Err()
}

// readFamilyCwd reads a session's working folder from its first records.
func readFamilyCwd(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(io.LimitReader(f, 256<<10))
	sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
	for sc.Scan() {
		var rec map[string]any
		if json.Unmarshal(sc.Bytes(), &rec) == nil {
			if cwd := asString(rec["cwd"]); cwd != "" {
				return cwd
			}
		}
	}
	return ""
}
