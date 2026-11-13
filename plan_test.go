package main

// Checks for plan mode: the prompt wrapper and the composer toggle.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/nsgotest"
)

// TestPlanPrompt checks the instruction comes before the user's words.
func TestPlanPrompt(t *testing.T) {
	defer setUILanguage(langZhCN)
	setUILanguage(langZhCN)
	got := planPrompt("把登录页的文案改一下")
	if !strings.Contains(got, "先给出一个可执行的计划") {
		t.Fatalf("plan prompt lacks the instruction: %q", got)
	}
	if !strings.HasSuffix(got, "把登录页的文案改一下") {
		t.Fatalf("plan prompt lost the request: %q", got)
	}
	setUILanguage(langEnUS)
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
	app.WaitFor("id:plan-mode", 5*time.Second)
	app.Press("id:plan-mode")
	app.WaitFor("id:composer", 5*time.Second)
}
