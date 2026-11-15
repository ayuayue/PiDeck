package main

// Checks the agent personas: the prompt prefix, the built-in and file
// lists, and the picker starting a session.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestPersonaPrompt(t *testing.T) {
	if got := personaPrompt("  be strict  ", "hi"); got != "be strict\n\nhi" {
		t.Fatalf("prompt = %q", got)
	}
	if got := personaPrompt("", "hi"); got != "hi" {
		t.Fatalf("empty = %q", got)
	}
}

func TestAgentList(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "agents"), 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"agents":[
		{"id":"team-review","name":"团队审查","description":"团队规则","prompt":"按团队规则审查。"},
		{"id":"review","name":"重复","prompt":"x"}
	]}`
	if err := os.WriteFile(filepath.Join(dir, "agents", "team.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	a := &app{st: st}
	list := a.agentList()
	if len(list) != len(builtinAgents())+1 {
		t.Fatalf("agents = %d: %+v", len(list), list)
	}
	if p := a.agentByID("team-review"); p == nil || p.Name != "团队审查" || p.Icon == nil {
		t.Fatalf("custom agent = %+v", p)
	}
	if p := a.agentByID("review"); p == nil || p.Name != "代码审查" {
		t.Fatalf("the built-in should win a duplicate id: %+v", p)
	}
	if a.agentByID("nope") != nil {
		t.Fatal("an unknown id should not resolve")
	}
}

func TestAgentSession(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := editorWorkspace(t)
	workspace := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PIDECK_LITE_HOME", home)
	app := openApp(t, workspace, 1280, 860)
	app.Press("id:rail-palette")
	app.WaitFor("text:用智能体新建会话…", 5*time.Second)
	app.Press("text:用智能体新建会话…")
	app.WaitFor("id:agent-dialog", 5*time.Second)
	app.Press("id:agent-review")
	app.WaitFor("id:persona-chip", 5*time.Second)
	raw, err := os.ReadFile(filepath.Join(home, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"sessionPersonas"`) || !strings.Contains(string(raw), `"review"`) {
		t.Fatalf("config = %s", raw)
	}
	if !strings.Contains(string(raw), "代码审查") {
		t.Fatalf("the title was not saved:\n%s", raw)
	}
	app.Press("id:persona-clear")
	app.WaitForGone("id:persona-chip", 5*time.Second)
}
