package main

// Checks deleting a local branch from the Git drawer.

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/nsgotest"
)

func TestGitDeleteBranch(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	t.Setenv("GIT_AUTHOR_NAME", "PiDeck Test")
	t.Setenv("GIT_AUTHOR_EMAIL", "pideck@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "PiDeck Test")
	t.Setenv("GIT_COMMITTER_EMAIL", "pideck@example.com")
	dir := t.TempDir()
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return string(out)
	}
	run("init")
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "first")
	run("branch", "feature")

	home := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	cfg, err := json.Marshal(config{Version: 2, Workspaces: []workspaceCfg{{Path: dir, Expanded: true}},
		Theme: "system", SidebarOpen: true, ScanPi: false})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), cfg, 0o644); err != nil {
		t.Fatal(err)
	}
	app := nsgotest.Start(t, Root, nsgotest.Size(1320, 860))
	app.Press("id:git-toggle")
	waitApp(app, "id:git-branch", 20*time.Second)
	app.Press("id:git-branch")
	app.WaitFor("id:git-branch-delete-feature", 10*time.Second)
	app.Press("id:git-branch-delete-feature")
	app.WaitFor("id:confirm-ok", 5*time.Second)
	app.Press("id:confirm-ok")
	deadline := time.Now().Add(10 * time.Second)
	for {
		out, err := exec.Command("git", "-C", dir, "branch", "--list", "feature").CombinedOutput()
		if err == nil && strings.TrimSpace(string(out)) == "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("branch still exists: %s, %v", out, err)
		}
		app.Settle()
		time.Sleep(50 * time.Millisecond)
	}
}
