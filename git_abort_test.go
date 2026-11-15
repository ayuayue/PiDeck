package main

// Checks abandoning a merge from the conflict dialog.

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

// conflictRepo makes a repository in the middle of a conflicting merge.
func conflictRepo(t *testing.T) (string, func(args ...string) (string, error)) {
	t.Helper()
	t.Setenv("GIT_AUTHOR_NAME", "PiDeck Test")
	t.Setenv("GIT_AUTHOR_EMAIL", "pideck@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "PiDeck Test")
	t.Setenv("GIT_COMMITTER_EMAIL", "pideck@example.com")
	dir := t.TempDir()
	file := filepath.Join(dir, "note.txt")
	run := func(args ...string) (string, error) {
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	must := func(args ...string) string {
		t.Helper()
		out, err := run(args...)
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
		return out
	}
	must("init")
	must("checkout", "-b", "main")
	if err := os.WriteFile(file, []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	must("add", ".")
	must("commit", "-m", "base")
	must("checkout", "-b", "feature")
	if err := os.WriteFile(file, []byte("feature\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	must("commit", "-am", "feature")
	must("checkout", "main")
	if err := os.WriteFile(file, []byte("main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	must("commit", "-am", "main")
	if _, err := run("merge", "feature"); err == nil {
		t.Fatal("the merge should conflict")
	}
	return dir, run
}

func TestGitAbortMerge(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir, run := conflictRepo(t)
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
	waitApp(app, "id:git-conflicts", 20*time.Second)
	app.Press("id:git-conflicts")
	app.WaitFor("id:git-abort-merge", 10*time.Second)
	app.Press("id:git-abort-merge")
	app.WaitFor("id:confirm-ok", 10*time.Second)
	app.Press("id:confirm-ok")

	deadline := time.Now().Add(20 * time.Second)
	for {
		data, readErr := os.ReadFile(filepath.Join(dir, "note.txt"))
		status, _ := run("status", "--porcelain")
		if readErr == nil && strings.TrimSpace(string(data)) == "main" && !strings.Contains(status, "UU") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("file = %q, status = %q", string(data), status)
		}
		time.Sleep(100 * time.Millisecond)
	}
	app.WaitForGone("id:git-conflicts", 20*time.Second)
}
