//go:build !js && !android && !ios

package workbench

// Checks for plan mode: the prompt wrapper and the composer toggle.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestPlanPrompt checks the instruction comes before the user's words.
func TestPlanPrompt(t *testing.T) {
	defer apptext.SetLanguage(apptext.LangZhCN)
	apptext.SetLanguage(apptext.LangZhCN)
	got := planPrompt("把登录页的文案改一下")
	if !strings.Contains(got, "先给出一个可执行的计划") {
		t.Fatalf("plan prompt lacks the instruction: %q", got)
	}
	if !strings.HasSuffix(got, "把登录页的文案改一下") {
		t.Fatalf("plan prompt lost the request: %q", got)
	}
	apptext.SetLanguage(apptext.LangEnUS)
	en := planPrompt("change the login copy")
	if !strings.Contains(en, "First give an executable plan") || !strings.HasSuffix(en, "change the login copy") {
		t.Fatalf("English plan prompt = %q", en)
	}
}

// TestPlanModeButton checks the composer's plan toggle exists and presses.
func TestPlanModeButton(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := editorWorkspace(t)
	workspace := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_LITE_HOME", home)
	app := openApp(t, workspace, 1280, 860)
	app.WaitFor("id:composer-add", 5*time.Second)
	app.Press("id:composer-add")
	app.WaitFor("text:计划模式", 5*time.Second)
	app.Press("text:计划模式")
	app.WaitFor("id:agent-mode-chip", 5*time.Second)
	app.Press("id:agent-mode-exit")
	app.WaitForGone("id:agent-mode-chip", 5*time.Second)
	app.WaitFor("id:composer", 5*time.Second)
}

// TestPlanSteps pulls numbered and bulleted steps out of a plan.
func TestPlanSteps(t *testing.T) {
	text := "# 计划\n\n1. 读取配置\n2. **修改 main.go**\n- 跑测试\n\n说明：这些只是步骤。\n"
	steps := planSteps(text)
	if len(steps) != 3 {
		t.Fatalf("steps = %v", steps)
	}
	if steps[0] != "读取配置" || steps[1] != "修改 main.go" || steps[2] != "跑测试" {
		t.Fatalf("steps = %v", steps)
	}
	if got := planSteps("只有一句话，没有步骤"); len(got) != 0 {
		t.Fatalf("plain text = %v", got)
	}
}

// TestPlanNext decides between steps from the turn's status.
func TestPlanNext(t *testing.T) {
	s := &session{planActive: true, planSteps: []string{"a", "b"}, planIndex: 0}
	if got := planNext(s, "completed"); got != planGoOn {
		t.Fatalf("first = %v", got)
	}
	s.planIndex = 1
	if got := planNext(s, "completed"); got != planFinished {
		t.Fatalf("last = %v", got)
	}
	if got := planNext(s, "failed"); got != planStopped {
		t.Fatalf("failed = %v", got)
	}
	if got := planNext(&session{}, "completed"); got != planStopped {
		t.Fatalf("inactive = %v", got)
	}
}

// TestPlanStepPrompt names the step and its place.
func TestPlanStepPrompt(t *testing.T) {
	s := &session{planActive: true, planSteps: []string{"a", "b"}, planIndex: 1}
	got := planStepPrompt(s)
	if !strings.Contains(got, "2/2") || !strings.Contains(got, "b") {
		t.Fatalf("prompt = %q", got)
	}
	if planStepPrompt(&session{}) != "" {
		t.Fatal("an empty plan should have no prompt")
	}
}
