//go:build !js && !android && !ios

package workbench

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
			[]todoItem{{Text: "读代码", Status: "completed"}, {Text: "改实现", Status: "in_progress"}}},
		{"items with title", `{"items":[{"title":"跑测试","status":"done"},{"title":"写文档"}]}`,
			[]todoItem{{Text: "跑测试", Status: "completed"}, {Text: "写文档", Status: "pending"}}},
		{"top-level array", `[{"text":"甲","status":"pending"},{"text":"乙","status":"cancelled"}]`,
			[]todoItem{{Text: "甲", Status: "pending"}, {Text: "乙", Status: "cancelled"}}},
		{"plain strings", `{"tasks":["一","二"]}`, []todoItem{{Text: "一", Status: "pending"}, {Text: "二", Status: "pending"}}},
		{"done bool", `{"list":[{"task":"已做","done":true}]}`, []todoItem{{Text: "已做", Status: "completed"}}},
		{"status aliases", `{"todos":[{"content":"a","status":"doing"},{"content":"b","status":"canceled"}]}`,
			[]todoItem{{Text: "a", Status: "in_progress"}, {Text: "b", Status: "cancelled"}}},
		{"subject and ids", `{"tasks":[{"id":7,"subject":"甲","status":"pending"},{"id":8,"subject":"乙"}]}`,
			[]todoItem{{ID: "7", Text: "甲", Status: "pending"}, {ID: "8", Text: "乙", Status: "pending"}}},
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
			if got[i].Text != c.want[i].Text || got[i].Status != c.want[i].Status {
				t.Errorf("%s: item %d = %+v, want %+v", c.name, i, got[i], c.want[i])
			}
			if c.name == "subject and ids" && got[i].ID != c.want[i].ID {
				t.Errorf("%s: item %d has id %q, want %q", c.name, i, got[i].ID, c.want[i].ID)
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
		{Text: "a", Status: "completed"}, {Text: "b", Status: "in_progress"},
		{Text: "c", Status: "pending"}, {Text: "d", Status: "cancelled"},
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

// TestApplyTodoArgs checks a list a tool sends whole, and the calls most
// tools make instead: create one task, then mark ids done.
func TestApplyTodoArgs(t *testing.T) {
	list := []todoItem{{ID: "1", Text: "读代码", Status: "in_progress"}, {ID: "2", Text: "改实现", Status: "pending"}}

	replaced, ok := applyTodoArgs(list, json.RawMessage(`{"action":"replace","items":[{"id":4,"text":"新计划"}]}`))
	if !ok || len(replaced) != 1 || replaced[0].Text != "新计划" || replaced[0].ID != "4" {
		t.Fatalf("replace = %+v, %v", replaced, ok)
	}

	created, ok := applyTodoArgs(list, json.RawMessage(`{"action":"create","subject":"补测试","status":"pending"}`))
	if !ok || len(created) != 3 || created[2].Text != "补测试" || created[2].ID != "3" {
		t.Fatalf("create = %+v, %v", created, ok)
	}
	if len(list) != 2 {
		t.Fatalf("a call changed the list it was given: %+v", list)
	}

	done, ok := applyTodoArgs(list, json.RawMessage(`{"action":"update","id":1,"status":"completed"}`))
	if !ok || done[0].Status != "completed" || done[1].Status != "pending" {
		t.Fatalf("update = %+v, %v", done, ok)
	}

	renamed, ok := applyTodoArgs(list, json.RawMessage(`{"action":"update","id":2,"activeForm":"正在改实现"}`))
	if !ok || renamed[1].Text != "正在改实现" || renamed[1].Status != "pending" {
		t.Fatalf("rename = %+v, %v", renamed, ok)
	}

	finished, ok := applyTodoArgs(list, json.RawMessage(`{"action":"complete","id":2}`))
	if !ok || finished[1].Status != "completed" {
		t.Fatalf("complete = %+v, %v", finished, ok)
	}

	kept, ok := applyTodoArgs(list, json.RawMessage(`{"action":"delete","id":1}`))
	if !ok || len(kept) != 1 || kept[0].ID != "2" {
		t.Fatalf("delete = %+v, %v", kept, ok)
	}

	bare, ok := applyTodoArgs(list, json.RawMessage(`{"id":1,"status":"completed"}`))
	if !ok || bare[0].Status != "completed" {
		t.Fatalf("bare update = %+v, %v", bare, ok)
	}

	if _, ok := applyTodoArgs(list, json.RawMessage(`{"action":"update","id":9,"status":"completed"}`)); ok {
		t.Error("an update of an item the list does not hold should change nothing")
	}
	if _, ok := applyTodoArgs(list, json.RawMessage(`{"action":"list"}`)); ok {
		t.Error("a read-only call should change nothing")
	}
}

// TestTodoPlanFromText reads the plan a result spells out, which is how a
// tool that answers with the whole plan is read.
func TestTodoPlanFromText(t *testing.T) {
	text := "Updated todo #2: 改实现\n\nTodos 1/2\n[completed] #1: 读代码\n[in_progress] #2: 改实现"
	items, ok := todoPlanFromText(text)
	if !ok || len(items) != 2 {
		t.Fatalf("plan = %+v, %v", items, ok)
	}
	if items[0].ID != "1" || items[0].Status != "completed" || items[1].Text != "改实现" || items[1].Status != "in_progress" {
		t.Errorf("plan = %+v", items)
	}
	if _, ok := todoPlanFromText("no plan here"); ok {
		t.Error("text without plan lines should read nothing")
	}
}

// TestTodosFromMessagesReplaysMutations checks history ends on the list the
// calls left, not on the first list a tool wrote.
func TestTodosFromMessagesReplaysMutations(t *testing.T) {
	call := func(name, args string) piContent {
		return piContent{Type: "toolCall", Name: name, Arguments: json.RawMessage(args)}
	}
	msgs := []piMessage{
		{Role: "assistant", Content: mustRaw(t, []piContent{
			call("todo", `{"action":"replace","items":[{"id":1,"text":"读代码","status":"in_progress"},{"id":2,"text":"改实现","status":"pending"}]}`),
		})},
		{Role: "assistant", Content: mustRaw(t, []piContent{
			call("todo", `{"action":"update","id":1,"status":"completed"}`),
		})},
		{Role: "toolResult", ToolName: "todo", Content: mustRaw(t, "Todos 1/2\n[completed] #1: 读代码\n[in_progress] #2: 改实现")},
		{Role: "assistant", Content: mustRaw(t, []piContent{
			call("todo", `{"action":"complete","id":2}`),
		})},
	}
	items := todosFromMessages(msgs)
	if len(items) != 2 || items[0].Status != "completed" || items[1].Status != "completed" {
		t.Fatalf("todos = %+v", items)
	}
}

// mustRaw encodes a message body for a history fixture.
func mustRaw(t *testing.T, value any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
