//go:build !js && !android && !ios

package workbench

// Checks the ask card: the envelope a pi extension sends, the answers it
// gets back, and the card's way through a batch.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestParseBatchAsk reads the extension's envelope, with options written
// both ways and fields the model left out.
func TestParseBatchAsk(t *testing.T) {
	title := `{"__piDeckBatchAsk":1,"review":true,"questions":[
		{"question":"选一个","options":["甲",{"label":"乙","value":"b","description":"说明"}]},
		{"id":"q9","type":"multi_select","question":"多选","options":["A","B"]},
		{"id":"x","type":"editor","question":"写点什么","prefill":"草稿"}
	]}`
	env, ok := parseBatchAsk(title)
	if !ok {
		t.Fatal("the envelope did not parse")
	}
	if !env.Review || len(env.Questions) != 3 {
		t.Fatalf("envelope = %+v", env)
	}
	first := env.Questions[0]
	if first.ID != "q1" || first.Type != askSelect || !first.AllowOther {
		t.Errorf("first question = %+v", first)
	}
	if len(first.Options) != 2 || first.Options[1].Value != "b" || first.Options[1].Description != "说明" {
		t.Errorf("options = %+v", first.Options)
	}
	if got := env.Questions[1]; got.ID != "q9" || got.Type != askMultiSelect {
		t.Errorf("second question = %+v", got)
	}
	if env.Questions[2].Prefill != "草稿" {
		t.Errorf("prefill = %q", env.Questions[2].Prefill)
	}

	if _, ok := parseBatchAsk("普通问题"); ok {
		t.Error("a plain title should not parse as an envelope")
	}
	if _, ok := parseBatchAsk(`{"__piDeckBatchAsk":2,"questions":[]}`); ok {
		t.Error("a foreign marker should not parse")
	}
	if _, ok := parseBatchAsk(`{"__piDeckBatchAsk":1,"questions":[{"question":""}]}`); ok {
		t.Error("no usable question should not parse")
	}
}

// TestAskOptionsFromStrings keeps the custom row the extension marks and
// splits a description out of a label.
func TestAskOptionsFromStrings(t *testing.T) {
	choices, other := askOptionsFromStrings([]string{"甲|先做这个", "✎自定义", "乙"})
	if !other {
		t.Error("the ✎ option should turn the custom row on")
	}
	if len(choices) != 2 {
		t.Fatalf("choices = %+v", choices)
	}
	if choices[0].Label != "甲" || choices[0].Description != "先做这个" {
		t.Errorf("first = %+v", choices[0])
	}
	if choices[1].Value != "乙" {
		t.Errorf("second = %+v", choices[1])
	}
}

// TestAskWire writes the answer envelope the extension parses: skipped is
// null, multi_select is a list, and text left in a field counts.
func TestAskWire(t *testing.T) {
	ask := &extensionAsk{Method: remotewire.AskMethodBatch, Questions: []askQuestion{
		{ID: "q1", Type: askSelect},
		{ID: "q2", Type: askMultiSelect},
		{ID: "q3", Type: askInput},
		{ID: "q4", Type: askEditor},
	}}
	state := askUIState{
		Answers: map[string]askAnswer{
			"q1": {Value: "b", Label: "乙"},
			"q2": {Value: []string{"A", "B"}, Label: "A、B"},
			"q4": {Skipped: true},
		},
	}
	texts := map[string]string{"q3": "  写完了  "}
	wire := askWire(ask, state, texts, false)
	data, err := json.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	for _, want := range []string{`"id":"q1"`, `"value":"b"`, `"value":["A","B"]`, `"value":"写完了"`, `"skipped":true`} {
		if !strings.Contains(got, want) {
			t.Errorf("wire lacks %s: %s", want, got)
		}
	}
	if strings.Contains(got, `"cancelled":true`) {
		t.Errorf("submitted answers should not be cancelled: %s", got)
	}
	if cancelled := askWire(ask, state, texts, true); !cancelled.Cancelled {
		t.Error("the close envelope should say cancelled")
	}
}

// newAskApp starts the app on a temp data dir with one session, without pi.
func newAskApp(t *testing.T) (*app, *nsgotest.App, *session) {
	t.Helper()
	home, dir := t.TempDir(), t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	raw, _ := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: dir, Name: "Ask"}},
		Theme: "system", SidebarOpen: true})
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	var built *app
	root := func(cx *core.Scope) core.Node { built = newApp(cx); return built.view() }
	screen := nsgotest.Start(t, root, nsgotest.Size(1280, 860))
	screen.Advance(200 * time.Millisecond)
	if built == nil {
		t.Fatal("the app did not start")
	}
	ws := &workspace{Path: dir}
	s := built.blankSession("ask-session", ws, "问一句话")
	built.byID[s.ID] = s
	built.all = append(built.all, s)
	built.tabs.Set([]string{s.ID})
	built.activeID.Set(s.ID)
	screen.Advance(50 * time.Millisecond)
	return built, screen, s
}

// TestAskBatchCard walks a batch: pick, toggle, type, review and submit.
func TestAskBatchCard(t *testing.T) {
	built, screen, s := newAskApp(t)
	built.enqueueAsk(s, &extensionAsk{ID: "r1", Method: remotewire.AskMethodBatch, Review: true,
		Questions: []askQuestion{
			{ID: "q1", Type: askSelect, Question: "先做哪一个？", AllowOther: true,
				Options: []askOption{{Label: "甲", Value: "a"}, {Label: "乙", Value: "b", Description: "说明"}}},
			{ID: "q2", Type: askMultiSelect, Question: "带上哪些？",
				Options: []askOption{{Label: "A", Value: "A"}, {Label: "B", Value: "B"}}},
			{ID: "q3", Type: askInput, Question: "写一句备注"},
		}})
	screen.Advance(50 * time.Millisecond)
	if len(screen.Query("id:ask-card")) == 0 {
		t.Fatal("the ask card did not show")
	}
	if len(screen.Query("id:composer-column")) == 0 {
		t.Fatal("the composer lost its column")
	}
	if len(screen.Query("id:editor")) != 0 {
		t.Fatal("the composer should wait behind the card")
	}
	shot(screen, "60-ask-batch")

	// Picking answers and moves on: one click per question.
	screen.Press("id:ask-option-a")
	screen.Advance(50 * time.Millisecond)
	if len(screen.Query("text:带上哪些？")) == 0 {
		t.Fatal("the second question did not come up")
	}

	// Toggling does not move on; the next button does.
	screen.Press("id:ask-multi-A")
	screen.Press("id:ask-multi-B")
	screen.Advance(50 * time.Millisecond)
	if len(screen.Query("text:带上哪些？")) == 0 {
		t.Fatal("a toggle should keep the question")
	}
	screen.Press("id:ask-next")
	screen.Advance(50 * time.Millisecond)
	if len(screen.Query("text:写一句备注")) == 0 {
		t.Fatal("the third question did not come up")
	}

	// Typing then submitting goes to the review page, as asked for.
	screen.Type("id:ask-text", "先跑测试")
	screen.Press("id:ask-text-submit")
	screen.Advance(50 * time.Millisecond)
	if len(screen.Query("id:ask-review-1")) == 0 || len(screen.Query("id:ask-review-2")) == 0 {
		t.Fatal("the review page did not show the answers")
	}
	shot(screen, "61-ask-review")
	screen.Press("id:ask-submit")
	screen.Advance(100 * time.Millisecond)
	if len(screen.Query("id:ask-card")) != 0 {
		t.Fatal("the card stayed after submitting")
	}
	if s.showingAsk() != nil {
		t.Fatal("the session still waits on an answer")
	}
}

// TestAskSkipAndClose checks skipping a question and closing a partly
// answered batch: both reach the model as the extension expects.
func TestAskSkipAndClose(t *testing.T) {
	built, screen, s := newAskApp(t)
	ask := &extensionAsk{ID: "r1", Method: remotewire.AskMethodBatch, Questions: []askQuestion{
		{ID: "q1", Type: askInput, Question: "第一个问题"},
		{ID: "q2", Type: askInput, Question: "第二个问题"},
	}}
	built.enqueueAsk(s, ask)
	screen.Advance(50 * time.Millisecond)
	screen.Type("id:ask-text", "答第一个")
	screen.Press("id:ask-text-submit")
	screen.Advance(50 * time.Millisecond)
	if len(screen.Query("text:第二个问题")) == 0 {
		t.Fatal("the second question did not come up")
	}
	screen.Press("id:ask-skip")
	screen.Advance(100 * time.Millisecond)
	if len(screen.Query("id:ask-card")) != 0 {
		t.Fatal("skipping the last question should submit the batch")
	}

	// Closing with one answer keeps it, as a cancelled envelope with the
	// answers that were given.
	ask2 := &extensionAsk{ID: "r2", Method: remotewire.AskMethodBatch, Questions: []askQuestion{
		{ID: "q1", Type: askConfirm, Question: "继续？"},
		{ID: "q2", Type: askInput, Question: "备注"},
	}}
	built.enqueueAsk(s, ask2)
	screen.Advance(50 * time.Millisecond)
	screen.Press("id:ask-confirm-yes")
	screen.Advance(50 * time.Millisecond)
	screen.Press("id:ask-card-close")
	screen.Advance(100 * time.Millisecond)
	if len(screen.Query("id:ask-card")) != 0 || s.showingAsk() != nil {
		t.Fatal("closing the card did not end the ask")
	}
}

// TestAskQueue checks a second request waits behind the first and comes up
// when it is answered.
func TestAskQueue(t *testing.T) {
	built, screen, s := newAskApp(t)
	built.enqueueAsk(s, &extensionAsk{ID: "r1", Method: "confirm", Title: "允许运行？"})
	built.enqueueAsk(s, &extensionAsk{ID: "r2", Method: "input", Title: "写一句"})
	screen.Advance(50 * time.Millisecond)
	if got := s.askPending.Get(); got != 2 {
		t.Fatalf("pending = %d, want 2", got)
	}
	if len(screen.Query("text:允许运行？")) == 0 {
		t.Fatal("the first request should show")
	}
	screen.Press("id:ask-confirm-yes")
	screen.Advance(50 * time.Millisecond)
	if got := s.askPending.Get(); got != 1 {
		t.Fatalf("pending after answering = %d, want 1", got)
	}
	if len(screen.Query("text:写一句")) == 0 {
		t.Fatal("the queued request did not come up")
	}
}

// TestStrips checks the to-do and goal strips above the composer.
func TestStrips(t *testing.T) {
	built, screen, s := newAskApp(t)
	s.todos.Set([]todoItem{
		{Text: "先读现有实现", Status: "completed"},
		{Text: "补协议与卡片", Status: "completed"},
		{Text: "写测试", Status: "in_progress"},
		{Text: "更新文档", Status: "pending"},
	})
	screen.Advance(60 * time.Millisecond)
	if len(screen.Query("id:todo-bar")) == 0 {
		t.Fatal("the to-do strip did not show")
	}
	shot(screen, "62-todo-strip")
	s.todoOpen.Set(true)
	screen.Advance(60 * time.Millisecond)
	if len(screen.Query("text:补协议与卡片")) == 0 {
		t.Fatal("the open strip did not list the items")
	}
	shot(screen, "63-todo-open")

	// A dismissed strip stays away until the list changes.
	screen.Press("id:todo-dismiss")
	screen.Advance(60 * time.Millisecond)
	if len(screen.Query("id:todo-bar")) != 0 {
		t.Fatal("the dismissed strip stayed")
	}
	s.todos.Set([]todoItem{{Text: "新的活", Status: "pending"}})
	screen.Advance(60 * time.Millisecond)
	if len(screen.Query("id:todo-bar")) == 0 {
		t.Fatal("a changed list should bring the strip back")
	}

	built.setAgentMode(s, modeGoal)
	s.goalRounds = 3
	s.goalText = "把 Ask 做完，直到测试全绿"
	built.bumpSessionUI(s)
	screen.Advance(60 * time.Millisecond)
	if len(screen.Query("id:goal-strip")) == 0 {
		t.Fatal("the goal strip did not show")
	}
	shot(screen, "64-goal-strip")
	screen.Press("id:goal-pause")
	screen.Advance(60 * time.Millisecond)
	if !s.goalPaused.GetUntracked() {
		t.Fatal("pausing did not hold the goal")
	}
}

// TestAskExtensionInstalled checks the bundled extension is written where
// pi can load it.
func TestAskExtensionInstalled(t *testing.T) {
	dir := t.TempDir()
	path := installAskExtension(dir)
	if path == "" {
		t.Fatal("the extension was not written")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `__piDeckBatchAsk`) || !strings.Contains(string(data), "ask_question") {
		t.Fatal("the written extension is not the ask extension")
	}
	if again := installAskExtension(dir); again != path {
		t.Fatalf("second install = %q", again)
	}
}
