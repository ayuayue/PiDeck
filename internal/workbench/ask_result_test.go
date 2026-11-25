//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/ui/chat"
)

const askResultFixture = `{"role":"toolResult","toolCallId":"ask-1","toolName":"ask_question",
	"content":[{"type":"text","text":"checks: unit、build\nconfirm: 否\nnote: 先检查"}],
	"details":{"questions":[
		{"id":"checks","type":"multi_select","question":"带上哪些检查？","options":[
			{"label":"单元测试","value":"unit","description":"验证逻辑"},
			{"label":"构建","value":"build"},{"label":"部署","value":"deploy"}]},
		{"id":"confirm","type":"confirm","question":"立即发布吗？"},
		{"id":"note","type":"input","question":"补充说明"},
		{"id":"skipped","type":"select","question":"选择环境","options":["测试","生产"]}],
		"answers":[{"id":"checks","type":"multi_select","value":["unit","build"]},
			{"id":"confirm","type":"confirm","value":false},
			{"id":"note","type":"input","value":"先检查"},
			{"id":"skipped","type":"select","value":null,"skipped":true}]}}`

func TestAskToolResultShowsQuestionsAndChoices(t *testing.T) {
	var message piMessage
	if err := json.Unmarshal([]byte(askResultFixture), &message); err != nil {
		t.Fatal(err)
	}
	run := toolRunFromResult(message)
	run.Action, run.Detail = "提问", "完成问答"
	built, screen, s := newAskApp(t)
	onNativeUI(t, screen, built, func() {
		now := built.cx.Now()
		s.loaded.Set(true)
		s.readySig.Set(true)
		s.turns.Set([]turn{{ID: "ask-result-turn", Prompt: "确认需要执行的检查", Final: "已完成确认。",
			Status: chat.Completed, Start: now.Add(-time.Second), End: now, Tools: 1,
			Steps: []turnStep{{ID: "ask-result-step", Tools: []toolRun{run}}}}})
	})
	screen.WaitFor("text:已完成确认。", 5*time.Second)
	screen.Press("text:1 个工具调用")
	screen.WaitFor("text:执行过程 · 1 个工具调用", 5*time.Second)
	screen.Press("text:执行过程 · 1 个工具调用")
	screen.WaitFor("label:提问 完成问答", 5*time.Second)
	screen.Press("label:提问 完成问答")
	screen.WaitFor("id:ask-result", 5*time.Second)
	for _, text := range []string{"带上哪些检查？", "单元测试", "验证逻辑", "构建", "部署", "立即发布吗？", "否", "补充说明", "先检查", "选择环境", "测试", "生产", "已跳过"} {
		if len(screen.Query(`text:"`+text+`"`)) == 0 {
			t.Errorf("the completed ask does not show %q", text)
		}
	}
	for _, selected := range []string{"checks-unit", "checks-build", "confirm-false"} {
		if len(screen.Query("id:ask-result-selected-"+selected)) != 1 {
			t.Errorf("selected answer %s is not marked", selected)
		}
	}
	for _, unselected := range []string{"checks-deploy", "confirm-true", "skipped-测试", "skipped-生产"} {
		if len(screen.Query("id:ask-result-selected-"+unselected)) != 0 {
			t.Errorf("unselected answer %s was marked", unselected)
		}
	}
	shot(screen, "76-completed-question-choices")
}

func TestAskToolResultDetailsLiveAndHistory(t *testing.T) {
	var message piMessage
	if err := json.Unmarshal([]byte(askResultFixture), &message); err != nil {
		t.Fatal(err)
	}
	live := toolRun{Name: "ask_question"}
	live.withDetails(message.Details)
	merged := mergeRun(toolRun{CallID: "ask-1", Name: "ask_question"}, live)
	history := toolRunFromResult(message)
	for _, run := range []toolRun{merged, history} {
		if run.Ask == nil || len(run.Ask.Questions) != 4 {
			t.Fatalf("question details lost in projection: %+v", run)
		}
		answer := run.Ask.answer(run.Ask.Questions[0])
		if values, ok := askStringList(answer.Value); !ok || len(values) != 2 {
			t.Fatalf("multiple selected values lost in projection: %+v", answer)
		}
	}
}

func TestAskToolResultIgnoresInvalidDetails(t *testing.T) {
	for _, raw := range []string{"null", "{", `{"questions":[]}`, `{"questions":[{"question":" "}]}`} {
		if result := askResultFromDetails("ask_question", json.RawMessage(raw)); result != nil {
			t.Errorf("invalid result details %q parsed as %+v", raw, result)
		}
	}
	if result := askResultFromDetails("read", json.RawMessage(`{"questions":[{"question":"Q"}]}`)); result != nil {
		t.Fatalf("ordinary tool output was treated as a question result: %+v", result)
	}
}
