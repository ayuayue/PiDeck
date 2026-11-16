package main

// Checks deleting a branch on the remote from the branch menu.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestGitDeleteRemoteBranch(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir, run := gitFixture(t)
	run("checkout", "-b", "featurex")
	if err := os.WriteFile(filepath.Join(dir, "feature.txt"), []byte("feature\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "feature work")
	run("push", "origin", "featurex")
	run("checkout", "main")

	app := startGitApp(t, dir)
	app.WaitFor("id:git-branch", 20*time.Second)
	app.Press("id:git-branch")
	app.WaitFor("id:git-remote-delete-origin/featurex", 10*time.Second)
	app.Press("id:git-remote-delete-origin/featurex")
	app.WaitFor("id:confirm-ok", 5*time.Second)
	app.Press("id:confirm-ok")

	deadline := time.Now().Add(30 * time.Second)
	for {
		out := strings.TrimSpace(run("ls-remote", "origin", "refs/heads/featurex"))
		if out == "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("remote still has featurex: %s", out)
		}
		time.Sleep(100 * time.Millisecond)
	}
	// The local branch is untouched: deleting on the remote is not a local delete.
	if got := strings.TrimSpace(run("branch", "--list", "featurex")); got == "" {
		t.Fatalf("local featurex disappeared")
	}
}
