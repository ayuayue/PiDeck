//go:build !js && !android && !ios

package workbench

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

// TestDiffFilesUnusualNames covers spaces, C-quoted non-ASCII bytes and the
// tab Git can put after a path.
func TestDiffFilesUnusualNames(t *testing.T) {
	nl := "\n"
	q := "\""
	bs := "\\"
	patch := "+++ b/with space.txt" + nl +
		"+++ " + q + "b/" + bs + "344" + bs + "270" + bs + "255" + q + nl +
		"+++ b/tabbed.txt" + "\t" + "(2026-06-01)" + nl
	want := []string{"with space.txt", "中", "tabbed.txt"}
	if got := diffFiles(patch); !slices.Equal(got, want) {
		t.Fatalf("diffFiles = %q, want %q", got, want)
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
	app.Press("id:git-tab-history")
	waitApp(app, "id:git-commit-row", 20*time.Second)
	app.Press("id:git-commit-row >> nth=0")
	app.WaitFor("id:git-diff", 10*time.Second)
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:git-diff-file")) == 2 })
	app.Press("id:git-diff-file >> nth=0")
	app.WaitFor("text:aaa", 10*time.Second)
}

// TestCommitDiffFileUnusualName opens a commit file whose name has a space
// and Chinese characters, which Git quotes differently in the patch.
func TestCommitDiffFileUnusualName(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir, run := gitFixture(t)
	name := "设计 说明.txt"
	if err := os.WriteFile(filepath.Join(dir, name), []byte("中文内容\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "unusual name")

	app := startGitApp(t, dir)
	app.Press("id:git-tab-history")
	waitApp(app, "id:git-commit-row", 20*time.Second)
	app.Press("id:git-commit-row >> nth=0")
	app.WaitFor("id:git-diff", 10*time.Second)
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:git-diff-file")) == 1 })
	app.Press("id:git-diff-file >> nth=0")
	app.WaitFor("text:中文内容", 10*time.Second)
}
