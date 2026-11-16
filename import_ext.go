//go:build !js && !android && !ios

package main

// Importing sessions from other agents: Codex's rollout files and Claude
// Code's project logs become pi sessions in the app's own store, so they
// can be browsed here and resumed like any other.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// importedMessage is one user or assistant message read from a file.
type importedMessage struct {
	Role string
	Text string
	Time time.Time
}

// sessionKind names the file's format.
type sessionKind string

const (
	kindPi     sessionKind = "pi"
	kindCodex  sessionKind = "codex"
	kindClaude sessionKind = "claude"
)

// detectSessionKind reads the first lines and says what wrote them.
func detectSessionKind(path string) sessionKind {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
	for i := 0; i < 20 && sc.Scan(); i++ {
		line := sc.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		var entry struct {
			Type      string `json:"type"`
			SessionID string `json:"sessionId"`
			Message   any    `json:"message"`
		}
		if json.Unmarshal([]byte(line), &entry) != nil {
			continue
		}
		switch entry.Type {
		case "session":
			return kindPi
		case "session_meta":
			return kindCodex
		}
		if entry.SessionID != "" && entry.Message != nil {
			return kindClaude
		}
	}
	return ""
}

// readCodexSession reads a rollout file's user and assistant messages.
func readCodexSession(path string) (cwd, title string, msgs []importedMessage, err error) {
	f, err := os.Open(path)
	if err != nil {
		return "", "", nil, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 16<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var entry struct {
			Timestamp string `json:"timestamp"`
			Type      string `json:"type"`
			Payload   struct {
				Type    string `json:"type"`
				Role    string `json:"role"`
				Cwd     string `json:"cwd"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"payload"`
		}
		if json.Unmarshal(line, &entry) != nil {
			continue
		}
		if entry.Type == "session_meta" {
			cwd = entry.Payload.Cwd
			continue
		}
		if entry.Type != "response_item" || entry.Payload.Type != "message" {
			continue
		}
		role := entry.Payload.Role
		if role != "user" && role != "assistant" {
			continue
		}
		var parts []string
		for _, c := range entry.Payload.Content {
			if c.Type == "input_text" || c.Type == "output_text" || c.Type == "text" {
				if strings.TrimSpace(c.Text) != "" {
					parts = append(parts, c.Text)
				}
			}
		}
		text := strings.TrimSpace(strings.Join(parts, "\n"))
		if text == "" {
			continue
		}
		t, _ := time.Parse(time.RFC3339Nano, entry.Timestamp)
		msgs = append(msgs, importedMessage{Role: role, Text: text, Time: t})
	}
	if len(msgs) == 0 {
		return "", "", nil, fmt.Errorf("没有读到可导入的消息")
	}
	for _, m := range msgs {
		if m.Role == "user" {
			title = firstLine(m.Text, 40)
			break
		}
	}
	return cwd, title, msgs, nil
}

// readClaudeSession reads a project log's main-thread messages.
func readClaudeSession(path string) (cwd, title string, msgs []importedMessage, err error) {
	f, err := os.Open(path)
	if err != nil {
		return "", "", nil, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 16<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var entry struct {
			Type        string          `json:"type"`
			Timestamp   string          `json:"timestamp"`
			Cwd         string          `json:"cwd"`
			IsSidechain bool            `json:"isSidechain"`
			IsMeta      bool            `json:"isMeta"`
			Message     json.RawMessage `json:"message"`
		}
		if json.Unmarshal(line, &entry) != nil {
			continue
		}
		if entry.Cwd != "" {
			cwd = entry.Cwd
		}
		if entry.IsSidechain || entry.IsMeta || (entry.Type != "user" && entry.Type != "assistant") {
			continue
		}
		var msg struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		}
		if json.Unmarshal(entry.Message, &msg) != nil {
			continue
		}
		text := claudeContentText(msg.Content)
		if strings.TrimSpace(text) == "" {
			continue
		}
		role := entry.Type
		if role != "user" && role != "assistant" {
			continue
		}
		t, _ := time.Parse(time.RFC3339Nano, entry.Timestamp)
		msgs = append(msgs, importedMessage{Role: role, Text: strings.TrimSpace(text), Time: t})
	}
	if len(msgs) == 0 {
		return "", "", nil, fmt.Errorf("没有读到可导入的消息")
	}
	for _, m := range msgs {
		if m.Role == "user" {
			title = firstLine(m.Text, 40)
			break
		}
	}
	return cwd, title, msgs, nil
}

// claudeContentText joins a Claude message's text blocks.
func claudeContentText(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	var parts []string
	for _, b := range blocks {
		if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n")
}

// importAnySession imports a pi, Codex or Claude session file.
func (s *store) importAnySession(src string) (sessionMeta, error) {
	switch detectSessionKind(src) {
	case kindPi:
		return s.importSession(src)
	case kindCodex:
		cwd, title, msgs, err := readCodexSession(src)
		if err != nil {
			return sessionMeta{}, err
		}
		return s.importConverted(kindCodex, cwd, "Codex · "+title, msgs)
	case kindClaude:
		cwd, title, msgs, err := readClaudeSession(src)
		if err != nil {
			return sessionMeta{}, err
		}
		return s.importConverted(kindClaude, cwd, "Claude · "+title, msgs)
	}
	return sessionMeta{}, fmt.Errorf("认不出这个会话文件的格式")
}

// importConverted writes imported messages as a pi session in the app's
// own store.
func (s *store) importConverted(kind sessionKind, cwd, title string, msgs []importedMessage) (sessionMeta, error) {
	if len(msgs) == 0 {
		return sessionMeta{}, fmt.Errorf("没有可导入的消息")
	}
	if cwd == "" {
		cwd = "."
	}
	id := newSessionID()
	now := time.Now().UTC()
	dir := filepath.Join(s.sessions, encodeCwd(filepath.Clean(cwd)))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return sessionMeta{}, err
	}
	var b strings.Builder
	head, _ := json.Marshal(map[string]any{
		"type": "session", "version": 3, "id": id, "timestamp": now.Format(time.RFC3339Nano), "cwd": cwd,
	})
	b.Write(head)
	b.WriteByte('\n')
	parent := ""
	for i, m := range msgs {
		when := m.Time
		if when.IsZero() {
			when = now
		}
		msgID := fmt.Sprintf("imp%d", i)
		content, _ := json.Marshal([]map[string]any{{"type": "text", "text": m.Text}})
		msg := map[string]any{"role": m.Role, "content": json.RawMessage(content), "timestamp": when.UnixMilli()}
		if m.Role == "assistant" {
			msg["api"] = "import"
			msg["provider"] = string(kind)
			msg["model"] = string(kind)
			msg["stopReason"] = "stop"
			msg["usage"] = map[string]any{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
				"totalTokens": 0, "cost": map[string]any{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}
		}
		line, _ := json.Marshal(map[string]any{
			"type": "message", "id": msgID, "parentId": parent, "timestamp": when.Format(time.RFC3339Nano), "message": msg,
		})
		b.Write(line)
		b.WriteByte('\n')
		parent = msgID
	}
	info, _ := json.Marshal(map[string]any{"type": "session_info", "name": title, "timestamp": now.Format(time.RFC3339Nano)})
	b.Write(info)
	b.WriteByte('\n')
	dst := filepath.Join(dir, now.Format("2006-01-02T15-04-05-000Z")+"_"+id+".jsonl")
	if err := os.WriteFile(dst, []byte(b.String()), 0o644); err != nil {
		return sessionMeta{}, err
	}
	m, ok := s.readMeta(dst, nil)
	if !ok {
		return sessionMeta{}, fmt.Errorf("导入后无法读取该会话")
	}
	return m, nil
}
