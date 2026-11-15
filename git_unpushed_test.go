package main

// Checks the commits ahead of the upstream, and undoing the last commit.

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

// gitFixture makes a repository with two commits and a bare origin the
// first one is pushed to. It returns the repository and a git runner.
func gitFixture(t *testing.T) (string, func(args ...string) string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	t.Setenv("GIT_AUTHOR_NAME", "PiDeck Test")
	t.Setenv("GIT_AUTHOR_EMAIL", "pideck@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "PiDeck Test")
	t.Setenv("GIT_COMMITTER_EMAIL", "pideck@example.com")
	dir := t.TempDir()
	remote := t.TempDir()
	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return string(out)
	}
	if out, err := exec.Command("git", "-C", remote, "init", "--bare").CombinedOutput(); err != nil {
		t.Fatalf("git init --bare: %v: %s", err, out)
	}
	run("init")
	run("checkout", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("first\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "first")
	run("remote", "add", "origin", remote)
	run("push", "-u", "origin", "main")
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("second\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("commit", "-am", "second")
	return dir, run
}

// startGitApp opens the app on a repository and the Git drawer.
func startGitApp(t *testing.T, dir string) *nsgotest.App {
	t.Helper()
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
	waitApp(app, "id:git-more", 20*time.Second)
	return app
}

// openGitMenu presses an item of the drawer's "more" menu.
func openGitMenu(t *testing.T, app *nsgotest.App, item string) {
	t.Helper()
	for i := 0; i < 4; i++ {
		if len(app.Query("role:menuitem "+item)) > 0 {
			return
		}
		app.Press("id:git-more")
		app.Settle()
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("menu item %q did not open", item)
}

func TestGitUnpushedCommits(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir, _ := gitFixture(t)
	app := startGitApp(t, dir)
	openGitMenu(t, app, "未推送的提交…")
	app.Press("role:menuitem 未推送的提交…")
	app.WaitFor("id:git-unpushed", 10*time.Second)
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:git-unpushed-row")) > 0 })
	found := false
	for _, row := range app.Query("id:git-unpushed-row") {
		if strings.Contains(row.Props.Label, "second") {
			found = true
		}
	}
	if !found {
		t.Fatal("the unpushed commit is not listed")
	}
	app.Press("id:git-unpushed-row >> nth=0")
	app.WaitFor("id:git-diff", 10*time.Second)
}

func TestGitResetLast(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir, run := gitFixture(t)
	app := startGitApp(t, dir)
	openGitMenu(t, app, "撤销上次提交…")
	app.Press("role:menuitem 撤销上次提交…")
	app.WaitFor("id:confirm-ok", 10*time.Second)
	app.Press("id:confirm-ok")

	deadline := time.Now().Add(20 * time.Second)
	for {
		if strings.TrimSpace(run("rev-list", "--count", "HEAD")) == "1" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("commits = %s, want 1", run("rev-list", "--count", "HEAD"))
		}
		time.Sleep(100 * time.Millisecond)
	}
	if status := run("status", "--porcelain"); !strings.Contains(status, "M  note.txt") {
		t.Fatalf("status after reset = %q, want a staged change", status)
	}
}
