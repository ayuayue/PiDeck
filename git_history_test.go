package main

// Checks the history of one file, opened from its diff.

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestGitFileHistory(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir, run := gitFixture(t)
	if err := os.WriteFile(filepath.Join(dir, "other.txt"), []byte("other\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "other file")
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("third\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("commit", "-am", "third")
	// One uncommitted change, so the file has a row to open.
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("dirty\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	app := startGitApp(t, dir)
	waitApp(app, "id:git-file >> nth=0", 20*time.Second)
	app.Press("id:git-file >> nth=0")
	app.WaitFor("id:git-diff", 10*time.Second)
	app.Press("id:git-file-history")
	app.WaitFor("id:git-file-history-dialog", 10*time.Second)
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:git-history-row")) == 3 })
	app.Press("id:git-history-row >> nth=0")
	app.WaitFor("id:git-diff", 10*time.Second)
}
