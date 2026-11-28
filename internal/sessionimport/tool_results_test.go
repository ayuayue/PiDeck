//go:build !js && !android && !ios

package sessionimport

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func readToolResultFixture(t *testing.T, source *Source, body string) Session {
	t.Helper()
	path := filepath.Join(t.TempDir(), "session.jsonl")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	parsed, err := source.Read(path)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func parallelToolResultFixture(source *Source) string {
	if source == Codex {
		return strings.Join([]string{
			`{"timestamp":"2026-06-01T10:00:00Z","type":"session_meta","payload":{"id":"parallel","cwd":"C:/work/app"}}`,
			`{"timestamp":"2026-06-01T10:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"检查两个文件"}]}}`,
			`{"timestamp":"2026-06-01T10:00:02Z","type":"response_item","payload":{"type":"function_call","name":"read","call_id":"t1","arguments":"{}"}}`,
			`{"timestamp":"2026-06-01T10:00:03Z","type":"response_item","payload":{"type":"function_call","name":"read","call_id":"t2","arguments":"{}"}}`,
			`{"timestamp":"2026-06-01T10:00:04Z","type":"response_item","payload":{"type":"function_call_output","call_id":"t2","output":"second file","is_error":true}}`,
			`{"timestamp":"2026-06-01T10:00:05Z","type":"response_item","payload":{"type":"function_call_output","call_id":"t1","output":"first file"}}`,
			`{"timestamp":"2026-06-01T10:00:06Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"检查完成"}]}}`,
			`{"timestamp":"2026-06-01T10:00:07Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"继续"}]}}`,
			`{"timestamp":"2026-06-01T10:00:08Z","type":"response_item","payload":{"type":"reasoning","summary":[{"text":"再想一下"}]}}`,
			`{"timestamp":"2026-06-01T10:00:09Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"好的"}]}}`,
		}, "\n") + "\n"
	}
	return strings.Join([]string{
		`{"type":"user","sessionId":"parallel","cwd":"C:/work/app","timestamp":"2026-06-01T10:00:01Z","message":{"role":"user","content":"检查两个文件"}}`,
		`{"type":"assistant","timestamp":"2026-06-01T10:00:02Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"read","input":{}},{"type":"tool_use","id":"t2","name":"read","input":{}}]}}`,
		`{"type":"user","timestamp":"2026-06-01T10:00:04Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"second file","is_error":true}]}}`,
		`{"type":"user","timestamp":"2026-06-01T10:00:05Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"first file"}]}}`,
		`{"type":"assistant","timestamp":"2026-06-01T10:00:06Z","message":{"role":"assistant","content":[{"type":"text","text":"检查完成"}]}}`,
		`{"type":"user","timestamp":"2026-06-01T10:00:07Z","message":{"role":"user","content":"继续"}}`,
		`{"type":"assistant","timestamp":"2026-06-01T10:00:08Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"再想一下"}]}}`,
		`{"type":"assistant","timestamp":"2026-06-01T10:00:09Z","message":{"role":"assistant","content":[{"type":"text","text":"好的"}]}}`,
	}, "\n") + "\n"
}

func TestImportParallelToolResults(t *testing.T) {
	for _, source := range []*Source{Claude, Qoder, Codex} {
		t.Run(source.Key, func(t *testing.T) {
			parsed := readToolResultFixture(t, source, parallelToolResultFixture(source))
			wantRoles := []string{"user", "assistant", "toolResult", "toolResult", "assistant", "user", "assistant"}
			var roles []string
			for _, msg := range parsed.Messages {
				roles = append(roles, msg.Role)
			}
			if strings.Join(roles, ",") != strings.Join(wantRoles, ",") {
				t.Fatalf("message roles = %v, want %v", roles, wantRoles)
			}
			for i, want := range []struct {
				id, text string
				isError  bool
			}{{"t2", "second file", true}, {"t1", "first file", false}} {
				got := parsed.Messages[i+2]
				if got.ToolCallID != want.id || got.Text != want.text || got.IsError != want.isError {
					t.Errorf("result %d = %+v, want id=%s text=%q isError=%v", i, got, want.id, want.text, want.isError)
				}
			}
		})
	}
}

func TestImportToolResultsAfterAssistantUpdate(t *testing.T) {
	for _, source := range []*Source{Claude, Qoder, Codex} {
		t.Run(source.Key, func(t *testing.T) {
			update := `{"type":"assistant","timestamp":"2026-06-01T10:00:04Z","message":{"role":"assistant","content":[{"type":"text","text":"还在等另一个文件"}]}}`
			if source == Codex {
				update = `{"timestamp":"2026-06-01T10:00:04Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"还在等另一个文件"}]}}`
			}
			lines := strings.Split(parallelToolResultFixture(source), "\n")
			for i, line := range lines {
				if strings.Contains(line, "first file") {
					lines = slices.Insert(lines, i, update)
					break
				}
			}
			parsed := readToolResultFixture(t, source, strings.Join(lines, "\n"))
			results := map[string]string{}
			for _, msg := range parsed.Messages {
				if msg.Role == "toolResult" {
					results[msg.ToolCallID] = msg.Text
				}
			}
			if len(results) != 2 || results["t1"] != "first file" || results["t2"] != "second file" {
				t.Fatalf("interleaved tool results = %v, want both original results", results)
			}
		})
	}
}

func TestImportAssistantTimestamps(t *testing.T) {
	for _, source := range []*Source{Claude, Qoder, Codex} {
		t.Run(source.Key, func(t *testing.T) {
			parsed := readToolResultFixture(t, source, parallelToolResultFixture(source))
			var assistants []Message
			for _, msg := range parsed.Messages {
				if msg.Role == "assistant" {
					assistants = append(assistants, msg)
				}
			}
			if len(assistants) != 3 {
				t.Fatalf("assistant messages = %d, want 3", len(assistants))
			}
			for i, second := range []int{2, 6, 8} {
				want := time.Date(2026, 6, 1, 10, 0, second, 0, time.UTC)
				if !assistants[i].Timestamp.Equal(want) {
					t.Errorf("assistant %d timestamp = %s, want %s", i, assistants[i].Timestamp, want)
				}
			}
		})
	}
}

func TestImportCodexBundledToolResults(t *testing.T) {
	for _, tool := range []struct {
		kind, name, text string
		fields           map[string]any
	}{
		{"web_search_call", "web_search", "（Codex 未在会话文件中保存联网检索结果正文）", nil},
		{"image_generation_call", "image_generation", "（生成了一张图片，见会话附件）", map[string]any{"result": "aGk="}},
		{"agent_message", "agent_message", "agent output", map[string]any{"content": []map[string]any{{"type": "output_text", "text": "agent output"}}}},
	} {
		for _, idField := range []string{"call_id", "id", ""} {
			t.Run(tool.kind+"/"+orDefault(idField, "generated-id"), func(t *testing.T) {
				payload := map[string]any{"type": tool.kind}
				for key, value := range tool.fields {
					payload[key] = value
				}
				if idField != "" {
					payload[idField] = "bundled-call"
				}
				line, err := json.Marshal(map[string]any{"timestamp": "2026-06-01T10:00:02Z", "type": "response_item", "payload": payload})
				if err != nil {
					t.Fatal(err)
				}
				body := `{"timestamp":"2026-06-01T10:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"检查"}]}}` + "\n" + string(line) + "\n" +
					`{"timestamp":"2026-06-01T10:00:03Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"完成"}]}}` + "\n"
				parsed := readToolResultFixture(t, Codex, body)
				if len(parsed.Messages) != 4 {
					t.Fatalf("messages = %+v, want user, assistant call, tool result, assistant reply", parsed.Messages)
				}
				call, result, reply := parsed.Messages[1], parsed.Messages[2], parsed.Messages[3]
				if call.Role != "assistant" || len(call.Blocks) != 1 || call.Blocks[0].Kind != "toolCall" || call.Blocks[0].Name != tool.name || call.StopReason != "toolUse" {
					t.Fatalf("tool call = %+v", call)
				}
				id := call.Blocks[0].ID
				if id == "" || result.Role != "toolResult" || result.ToolCallID != id || result.ToolName != tool.name || result.Text != tool.text {
					t.Errorf("tool result = %+v, want id=%q name=%q text=%q", result, id, tool.name, tool.text)
				}
				if reply.Role != "assistant" || len(reply.Blocks) != 1 || reply.Blocks[0].Text != "完成" || reply.StopReason != "stop" {
					t.Errorf("reply = %+v, want a separate completed assistant message", reply)
				}
			})
		}
	}
}

func TestImportConverterUpgrade(t *testing.T) {
	for _, source := range []*Source{Claude, Qoder, Codex} {
		t.Run(source.Key, func(t *testing.T) {
			old := *source
			old.Version = 1
			candidate := Candidate{Source: source.Key, ID: "upgrade", Path: "source.jsonl", MTime: time.Unix(100, 0)}
			var out bytes.Buffer
			if err := WritePiSession(&out, "fixture1234567890", "C:/work", "test", candidate.MTime, Session{}, old, candidate); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "imported.jsonl")
			if err := os.WriteFile(path, out.Bytes(), 0o600); err != nil {
				t.Fatal(err)
			}
			if got := StateOf(path, candidate, old.Version); got != Current {
				t.Fatalf("original converter state = %v, want Current", got)
			}
			if got := StateOf(path, candidate, source.Version); got != Outdated {
				t.Errorf("upgraded converter state = %v, want Outdated", got)
			}
		})
	}
}
