//go:build !js && !android && !ios

package workbench

// Checks the composer's modes, its delivery choices and that its controls
// are where the row expects them.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestGoalPrompt checks the goal wraps a request with its marks.
func TestGoalPrompt(t *testing.T) {
	defer apptext.SetLanguage(apptext.LangZhCN)
	apptext.SetLanguage(apptext.LangZhCN)
	got := goalPrompt("把登录页改成新的设计")
	if !strings.Contains(got, "多轮推进的目标") {
		t.Fatalf("goal prompt lacks the instruction: %q", got)
	}
	if !strings.Contains(got, goalDoneMark) || !strings.Contains(got, goalBlockedMark) {
		t.Fatalf("goal prompt lacks its marks: %q", got)
	}
	if !strings.HasSuffix(got, "把登录页改成新的设计") {
		t.Fatalf("goal prompt lost the request: %q", got)
	}
	apptext.SetLanguage(apptext.LangEnUS)
	en := goalPrompt("redo the login page")
	if !strings.Contains(en, goalDoneMark) || !strings.HasSuffix(en, "redo the login page") {
		t.Fatalf("English goal prompt = %q", en)
	}
}

// TestGoalContinue checks a round names itself.
func TestGoalContinue(t *testing.T) {
	apptext.SetLanguage(apptext.LangZhCN)
	defer apptext.SetLanguage(apptext.LangZhCN)
	got := goalContinuePrompt(3)
	if !strings.Contains(got, "3") || !strings.Contains(got, goalDoneMark) {
		t.Fatalf("continue prompt = %q", got)
	}
}

// TestGoalNext decides whether a goal goes on.
func TestGoalNext(t *testing.T) {
	cases := []struct {
		mode, status, answer string
		rounds               int
		want                 goalState
	}{
		{modeGoal, "completed", "改好了，测试通过。", 1, goalGoOnState},
		{modeGoal, "completed", "全部做完。\n" + goalDoneMark, 3, goalFinishedState},
		{modeGoal, "completed", goalBlockedMark + "：选哪个方案？", 2, goalBlockedState},
		{modeGoal, "cancelled", "停下", 1, goalBlockedState},
		{modeGoal, "failed", "", 1, goalBlockedState},
		{modeGoal, "completed", "还没完", goalMaxRounds, goalBlockedState},
		{modePlan, "completed", "还没完", 1, goalBlockedState},
		{modeNormal, "completed", goalDoneMark, 1, goalBlockedState},
	}
	for _, c := range cases {
		if got := goalNextFor(c.mode, c.status, c.answer, c.rounds); got != c.want {
			t.Errorf("goalNextFor(%q, %q, %q, %d) = %v, want %v", c.mode, c.status, c.answer, c.rounds, got, c.want)
		}
	}
}

// TestDelivery checks how a message joins a running turn.
func TestDelivery(t *testing.T) {
	cases := []struct{ backend, chosen, want string }{
		{"", "", deliverySteer},
		{"", deliveryFollowUp, deliveryFollowUp},
		{"", deliverySteer, deliverySteer},
		{"", deliveryParallel, deliverySteer}, // never a running turn's choice
		{"acp", "", deliveryFollowUp},
		{"acp", deliverySteer, deliveryFollowUp},
	}
	for _, c := range cases {
		if got := deliveryFor(c.backend, c.chosen); got != c.want {
			t.Errorf("deliveryFor(%q, %q) = %q, want %q", c.backend, c.chosen, got, c.want)
		}
	}
}

// TestQueuedMessages takes and pops held messages.
func TestQueuedMessages(t *testing.T) {
	list := []queuedMessage{{ID: "a", Text: "one"}, {ID: "b", Text: "two"}}
	rest, first := popQueued(list)
	if first == nil || first.ID != "a" || len(rest) != 1 || rest[0].ID != "b" {
		t.Fatalf("popQueued = %v, %v", rest, first)
	}
	if _, none := popQueued(nil); none != nil {
		t.Fatal("an empty list has nothing to pop")
	}
	rest, taken := takeQueued(list, "b")
	if taken == nil || taken.Text != "two" || len(rest) != 1 || rest[0].ID != "a" {
		t.Fatalf("takeQueued = %v, %v", rest, taken)
	}
	rest, missing := takeQueued(list, "zz")
	if missing != nil || len(rest) != 2 {
		t.Fatalf("takeQueued of a missing id = %v, %v", rest, missing)
	}
}

// TestModeChip checks the add menu turns a mode on and the chip off.
func TestModeChip(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	app := composerApp(t)
	app.Press("id:composer-add")
	app.WaitFor("text:目标模式", 5*time.Second)
	app.Press("text:目标模式")
	app.WaitFor("id:agent-mode-chip", 5*time.Second)
	if len(app.Query("text:目标")) == 0 {
		t.Fatal("the goal chip does not name the goal")
	}
	app.Press("id:agent-mode-exit")
	app.WaitForGone("id:agent-mode-chip", 5*time.Second)
	// Image mode keeps the picture settings in the row and warns that no
	// provider is configured.
	app.Press("id:composer-add")
	app.WaitFor("text:生图模式", 5*time.Second)
	app.Press("text:生图模式")
	waitApp(app, "id:image-options", 10*time.Second)
	waitApp(app, "text:描述要画的画面…", 10*time.Second)
}

// TestBackendPicker lists the backends and locks once the session starts.
func TestBackendPicker(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	app := composerApp(t)
	app.Press("id:backend-picker")
	app.WaitFor("text:ACP 智能体", 5*time.Second)
	app.WaitFor("text:本机 pi 会话", 5*time.Second)
	app.WaitFor("text:Claude Agent", 5*time.Second)
	app.Press("text:本机 pi 会话")
	app.WaitForGone("text:ACP 智能体", 5*time.Second)
}

// TestSendBehaviorMenu offers both queues and parallel sending.
func TestSendBehaviorMenu(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	app := composerApp(t)
	app.Press("id:send-behavior")
	app.WaitFor("text:加入当前回合", 5*time.Second)
	app.WaitFor("text:排队到下一轮", 5*time.Second)
	app.WaitFor("text:并行发送", 5*time.Second)
	app.Press("text:排队到下一轮")
	app.WaitForGone("text:运行中发送时", 5*time.Second)
}

// composerApp opens the app over a project with a file, so the composer is
// the one a session shows.
func composerApp(t *testing.T) *nsgotest.App {
	t.Helper()
	home := editorWorkspace(t)
	workspace := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_LITE_HOME", home)
	app := openApp(t, workspace, 1280, 860)
	for _, id := range []string{"id:composer", "id:composer-card", "id:backend-picker", "id:composer-add",
		"id:model-picker", "id:context-meter", "id:send-behavior"} {
		app.Find(id)
	}
	return app
}
