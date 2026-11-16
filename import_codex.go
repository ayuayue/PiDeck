//go:build !js && !android && !ios

package main

// OpenAI Codex CLI's rollouts: one JSONL file per session under date
// folders, whose first line names the session and the folder it ran in.

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// sourceCodex reads Codex CLI's rollout files.
var sourceCodex = &importSource{
	Key: "codex", Label: "Codex CLI", Version: 1,
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
type codexLine struct {
	Timestamp string `json:"timestamp"`
	Type      string `json:"type"`
	Payload   struct {
		Type      string          `json:"type"`
		Role      string          `json:"role"`
		Cwd       string          `json:"cwd"`
		ID        string          `json:"id"`
		Model     string          `json:"model"`
		Provider  string          `json:"provider"`
		Content   json.RawMessage `json:"content"`
		Name      string          `json:"name"`
		Arguments string          `json:"arguments"`
		Input     json.RawMessage `json:"input"`
		Output    any             `json:"output"`
		CallID    string          `json:"call_id"`
		Summary   []any           `json:"summary"`
		Message   string          `json:"message"`
	} `json:"payload"`
}

// scanCodex lists the rollouts under one root.
func scanCodex(root string) ([]importCandidate, error) {
	var files []string
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(strings.ToLower(d.Name()), ".jsonl") {
			return nil
		}
		files = append(files, path)
		return nil
	})
	return scanHeads(files, func(path string) (importCandidate, bool) {
		info, err := os.Stat(path)
		if err != nil {
			return importCandidate{}, false
		}
		f, err := os.Open(path)
		if err != nil {
			return importCandidate{}, false
		}
		defer f.Close()
		sc := bufio.NewScanner(io.LimitReader(f, 1<<20))
		sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
		var cand importCandidate
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
				if cand.Title == "" {
					cand.Title = firstLine(codexMessageText(e.Payload.Content), 60)
				}
			case e.Type == "response_item" && e.Payload.Type == "message":
				cand.Count++
			}
		}
		if cand.ID == "" {
			return importCandidate{}, false
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

// readCodex converts one rollout into pi's terms.
func readCodex(path string) (importedSession, error) {
	f, err := os.Open(path)
	if err != nil {
		return importedSession{}, err
	}
	defer f.Close()
	out := importedSession{}
	pending := map[string]bool{}
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
		switch e.Type {
		case "session_meta":
			out.Cwd = e.Payload.Cwd
			continue
		case "turn_context":
			if out.Cwd == "" {
				out.Cwd = e.Payload.Cwd
			}
			continue
		case "response_item":
		default:
			continue
		}
		switch e.Payload.Type {
		case "message":
			role := e.Payload.Role
			if role != "user" && role != "assistant" {
				continue
			}
			blocks := codexBlocks(e.Payload.Content, role)
			if len(blocks) == 0 {
				continue
			}
			out.Messages = append(out.Messages, importMessage{Role: role, Timestamp: at, Blocks: blocks,
				Model: e.Payload.Model, Provider: e.Payload.Provider, StopReason: importStopReason("", false)})
			if role == "user" && out.Title == "" {
				for _, b := range blocks {
					if b.Kind == "text" && strings.TrimSpace(b.Text) != "" {
						out.Title = firstLine(b.Text, 60)
						break
					}
				}
			}
		case "reasoning":
			// Codex's own thinking: kept as the turn's thinking, only when
			// it actually said something.
			text := codexMessageText(e.Payload.Content)
			if strings.TrimSpace(text) == "" {
				text = codexSummaryText(e.Payload.Summary)
			}
			if strings.TrimSpace(text) == "" {
				continue
			}
			out.Messages = append(out.Messages, importMessage{Role: "assistant", Timestamp: at,
				Blocks: []importBlock{{Kind: "thinking", Thinking: text}}, Provider: e.Payload.Provider})
		case "function_call", "custom_tool_call", "local_shell_call":
			name := e.Payload.Name
			if name == "" {
				name = e.Payload.Type
			}
			args := importArguments(e.Payload.Arguments)
			if len(e.Payload.Input) > 0 {
				args = importArguments(string(e.Payload.Input))
			}
			id := e.Payload.CallID
			if id == "" {
				id = e.Payload.ID
			}
			out.Messages = append(out.Messages, importMessage{Role: "assistant", Timestamp: at,
				Blocks:     []importBlock{{Kind: "toolCall", ID: id, Name: name, Arguments: args}},
				Provider:   e.Payload.Provider,
				StopReason: "toolUse"})
			pending[id] = true
		case "function_call_output", "custom_tool_call_output", "local_shell_call_output":
			id := e.Payload.CallID
			if id == "" {
				id = e.Payload.ID
			}
			text := importToolOutput(e.Payload.Output)
			delete(pending, id)
			out.Messages = append(out.Messages, importMessage{Role: "toolResult", Text: text, Timestamp: at,
				ToolCallID: id, ToolName: "tool"})
		}
	}
	if out.Cwd == "" {
		if cand, ok := codexHeadOf(path); ok {
			out.Cwd = cand.Cwd
		}
	}
	return out, sc.Err()
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
func codexBlocks(raw json.RawMessage, role string) []importBlock {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		if strings.TrimSpace(text) == "" {
			return nil
		}
		return []importBlock{{Kind: "text", Text: text}}
	}
	var items []map[string]any
	if json.Unmarshal(raw, &items) != nil {
		return nil
	}
	var blocks []importBlock
	for _, item := range items {
		switch asString(item["type"]) {
		case "input_text", "output_text", "text":
			if t := asString(item["text"]); t != "" {
				blocks = append(blocks, importBlock{Kind: "text", Text: t})
			}
		case "input_image", "image":
			blocks = append(blocks, importImageBlock(asString(item["image_url"]), asString(item["mime_type"]),
				asString(item["filename"])))
		case "refusal":
			if t := asString(item["refusal"]); t != "" {
				blocks = append(blocks, importBlock{Kind: "text", Text: t})
			}
		}
	}
	return blocks
}

// codexHeadOf reads a rollout's header for its folder.
func codexHeadOf(path string) (importCandidate, bool) {
	f, err := os.Open(path)
	if err != nil {
		return importCandidate{}, false
	}
	defer f.Close()
	sc := bufio.NewScanner(io.LimitReader(f, 64<<10))
	sc.Buffer(make([]byte, 0, 8<<10), 1<<20)
	for i := 0; i < 8 && sc.Scan(); i++ {
		var e codexLine
		if json.Unmarshal(sc.Bytes(), &e) == nil && e.Type == "session_meta" {
			return importCandidate{ID: e.Payload.ID, Cwd: e.Payload.Cwd}, true
		}
	}
	return importCandidate{}, false
}
