//go:build !js && !android && !ios

package workbench

// Checks the strips' data: the agent's list with a plan's steps and the
// lines extensions publish, and the progress line PiDeck shows.

import (
	"strings"
	"testing"
)

// TestParseWidgetTodos reads PiDeck's widget lines: markers give status,
// progress and section lines are left out, numbering is trimmed.
func TestParseWidgetTodos(t *testing.T) {
	lines := []string{
		"[[pid:todo-plan:abc:3]]",
		"计划进度 1/3",
		"── 主线 ──",
		"☑ #1 先读代码",
		"◐ #2 改接口",
		"☐ 3. 补测试",
		"[x] 收尾",
		"1/3",
		"",
	}
	got := parseWidgetTodos(lines)
	want := []todoItem{
		{Text: "先读代码", Status: "completed"},
		{Text: "改接口", Status: "in_progress"},
		{Text: "补测试", Status: "pending"},
		{Text: "收尾", Status: "completed"},
	}
	if len(got) != len(want) {
		t.Fatalf("items = %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("item %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

// TestTodoProgressText counts each status the way the strip says it.
func TestTodoProgressText(t *testing.T) {
	items := []todoItem{
		{Text: "a", Status: "completed"},
		{Text: "b", Status: "completed"},
		{Text: "c", Status: "in_progress"},
		{Text: "d", Status: "pending"},
		{Text: "e", Status: "cancelled"},
	}
	got := todoProgressText(items)
	for _, want := range []string{"2", "1", "完成", "进行中", "待处理"} {
		if !strings.Contains(got, want) {
			t.Errorf("progress = %q, lacks %q", got, want)
		}
	}
	if strings.Contains(todoProgressText(nil), "·") {
		t.Error("an empty list should say nothing")
	}
}

// TestPlanTodos walks a plan: steps behind are done, the next runs.
func TestPlanTodos(t *testing.T) {
	s := &session{planActive: true, planSteps: []string{"一步", "二步", "三步"}, planIndex: 1}
	got := planTodos(s)
	if len(got) != 3 || got[0].Status != "completed" || got[1].Status != "completed" || got[2].Status != "in_progress" {
		t.Fatalf("plan todos = %+v", got)
	}
	s.planActive = false
	if planTodos(s) != nil {
		t.Error("a plan not running should add nothing")
	}
}
