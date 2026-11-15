package main

// Checks the files a commit's patch touches, and opening one from it.

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestDiffFiles(t *testing.T) {
	patch := "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+y\n" +
		"diff --git a/dir/b.txt b/dir/b.txt\n--- a/dir/b.txt\n+++ b/dir/b.txt\n@@ -1 +1 @@\n-x\n+y\n" +
		"diff --git a/gone.txt b/gone.txt\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n"
	if got := diffFiles(patch); !slices.Equal(got, []string{"a.txt", "dir/b.txt"}) {
		t.Fatalf("diffFiles = %v", got)
	}
	if got := diffFiles("no patch here"); got != nil {
		t.Fatalf("empty patch = %v", got)
	}
}

// TestCommitDiffFiles opens a file from a commit's patch.
func TestCommitDiffFiles(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir, run := gitFixture(t)
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("aaa\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "b.txt"), []byte("bbb\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "two files")

	app := startGitApp(t, dir)
	waitApp(app, "id:git-commit-row", 20*time.Second)
	app.Press("id:git-commit-row >> nth=0")
	app.WaitFor("id:git-diff", 10*time.Second)
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:git-diff-file")) == 2 })
	app.Press("id:git-diff-file >> nth=0")
	app.WaitFor("text:aaa", 10*time.Second)
}
