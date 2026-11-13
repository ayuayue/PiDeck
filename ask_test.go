package main

// Checks for the parallel inquiry: background text and the dialog.

import (
	"strings"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/nsgotest"
)

// TestAskContextText checks only the newest turns are kept, newest last.
func TestAskContextText(t *testing.T) {
	turns := []turn{
		{Prompt: "旧问题", Final: "旧回答"},
		{Prompt: "中问题", Final: "中回答"},
		{Prompt: "新问题", Final: "新回答"},
	}
	got := askContextTextFrom(turns, 2)
	if strings.Contains(got, "旧问题") {
		t.Fatalf("old turn stayed: %q", got)
	}
	for _, want := range []string{"中问题", "中回答", "新问题", "新回答"} {
		if !strings.Contains(got, want) {
			t.Errorf("context lacks %q: %q", want, got)
		}
	}
	if strings.Index(got, "中问题") > strings.Index(got, "新问题") {
		t.Errorf("turns are out of order: %q", got)
	}
	if askContextTextFrom(nil, 3) != "" {
		t.Error("no turns should give no context")
	}
}

// TestAskStatus checks the line under the field.
func TestAskStatus(t *testing.T) {
	if got := askStatus(askBox{Busy: true}); !strings.Contains(got, "正在") {
		t.Errorf("busy = %q", got)
	}
	if got := askStatus(askBox{Err: "失败原因"}); !strings.Contains(got, "失败原因") {
		t.Errorf("error = %q", got)
	}
	if got := askStatus(askBox{Answer: "答案"}); got != "" {
		t.Errorf("answer should not be a status: %q", got)
	}
}

// TestAskDialog checks the dialog opens, takes a question and closes.
func TestAskDialog(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(1200, 800))
	app.Key("mod+shift+a")
	app.WaitFor("id:ask-dialog", 5*time.Second)
	app.Type("id:ask-text", "什么是闭包？")
	if got := app.Find("id:ask-text").Text; !strings.Contains(got, "闭包") {
		t.Fatalf("question field = %q", got)
	}
	app.Press("id:ask-close")
	app.WaitForGone("id:ask-dialog", 5*time.Second)
}
