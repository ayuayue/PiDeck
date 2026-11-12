package main

// Checks for reading the agent's task list out of its todo tool calls.

import (
	"encoding/json"
	"testing"
)

// TestParseTodoArgs checks the shapes tools use for a task list.
func TestParseTodoArgs(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want []todoItem
	}{
		{"todos", `{"todos":[{"content":"读代码","status":"completed"},{"content":"改实现","status":"in_progress"}]}`,
			[]todoItem{{"读代码", "completed"}, {"改实现", "in_progress"}}},
		{"items with title", `{"items":[{"title":"跑测试","status":"done"},{"title":"写文档"}]}`,
			[]todoItem{{"跑测试", "completed"}, {"写文档", "pending"}}},
		{"top-level array", `[{"text":"甲","status":"pending"},{"text":"乙","status":"cancelled"}]`,
			[]todoItem{{"甲", "pending"}, {"乙", "cancelled"}}},
		{"plain strings", `{"tasks":["一","二"]}`, []todoItem{{"一", "pending"}, {"二", "pending"}}},
		{"done bool", `{"list":[{"task":"已做","done":true}]}`, []todoItem{{"已做", "completed"}}},
		{"status aliases", `{"todos":[{"content":"a","status":"doing"},{"content":"b","status":"canceled"}]}`,
			[]todoItem{{"a", "in_progress"}, {"b", "cancelled"}}},
	}
	for _, c := range cases {
		got, ok := parseTodoArgs(json.RawMessage(c.raw))
		if !ok {
			t.Errorf("%s: not read", c.name)
			continue
		}
		if len(got) != len(c.want) {
			t.Errorf("%s: %d items, want %d: %+v", c.name, len(got), len(c.want), got)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("%s: item %d = %+v, want %+v", c.name, i, got[i], c.want[i])
			}
		}
	}
	if _, ok := parseTodoArgs(json.RawMessage(`{"todos":[]}`)); ok {
		t.Error("an empty list should not replace a task list")
	}
	if _, ok := parseTodoArgs(json.RawMessage(`not json`)); ok {
		t.Error("garbage should not replace a task list")
	}
}

// TestTodoCounts checks cancelled items are not counted.
func TestTodoCounts(t *testing.T) {
	done, total := todoCounts([]todoItem{
		{"a", "completed"}, {"b", "in_progress"}, {"c", "pending"}, {"d", "cancelled"},
	})
	if done != 1 || total != 3 {
		t.Fatalf("done, total = %d, %d; want 1, 3", done, total)
	}
}

// TestTodosFromMessages checks the newest list wins.
func TestTodosFromMessages(t *testing.T) {
	first := `{"todos":[{"content":"旧任务","status":"pending"}]}`
	second := `{"todos":[{"content":"新任务","status":"completed"}]}`
	msgs := []piMessage{
		{Role: "assistant", Content: json.RawMessage(`[{"type":"toolCall","name":"todo","arguments":` + first + `}]`)},
		{Role: "assistant", Content: json.RawMessage(`[{"type":"toolCall","name":"todo_write","arguments":` + second + `}]`)},
	}
	got := todosFromMessages(msgs)
	if len(got) != 1 || got[0].Text != "新任务" || got[0].Status != "completed" {
		t.Fatalf("todos = %+v", got)
	}
	if !isTodoTool("todowrite") || !isTodoTool("TODO") || isTodoTool("bash") {
		t.Fatal("isTodoTool is wrong")
	}
}
