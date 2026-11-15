package main

// Checks attributing a file's lines to commits.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestParseGitBlame(t *testing.T) {
	const a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	raw := strings.Join([]string{
		a + " 1 1 1", "author Alice", "author-time 1767000000", "summary first", "filename a.txt", "\tone",
		a + " 2 2 1", "author Alice", "author-time 1767000000", "summary first", "filename a.txt", "\ttwo",
		b + " 3 3 1", "author Bob", "author-time 1767000100", "summary second", "filename a.txt", "\tthree",
	}, "\n")
	ranges := parseGitBlame(raw)
	if len(ranges) != 2 {
		t.Fatalf("ranges = %d (%+v), want 2", len(ranges), ranges)
	}
	if ranges[0].Hash != a || ranges[0].Start != 1 || ranges[0].End != 2 || ranges[0].Author != "Alice" {
		t.Fatalf("first = %+v", ranges[0])
	}
	if ranges[1].Hash != b || ranges[1].Start != 3 || ranges[1].End != 3 || ranges[1].Subject != "second" {
		t.Fatalf("second = %+v", ranges[1])
	}
	if got := ranges[0].short(); got != "aaaaaaa" {
		t.Fatalf("short = %q", got)
	}
}

func TestGitBlameDialog(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir, run := gitFixture(t)
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-m", "two lines")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\nthree\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("commit", "-am", "third line")
	// One uncommitted change, so the file has a row to open.
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\nthree\nfour\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	app := startGitApp(t, dir)
	waitApp(app, "id:git-file >> nth=0", 20*time.Second)
	app.Press("id:git-file >> nth=0")
	app.WaitFor("id:git-diff", 10*time.Second)
	app.WaitFor("id:git-file-blame", 5*time.Second)
	for i := 0; i < 4; i++ {
		if len(app.Query("id:git-blame")) > 0 {
			break
		}
		app.Press("id:git-file-blame")
		app.Settle()
		time.Sleep(100 * time.Millisecond)
	}
	app.WaitFor("id:git-blame", 10*time.Second)
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("id:blame-row")) >= 2 })
	app.Press("id:blame-row >> nth=0")
	app.WaitFor("id:git-diff", 10*time.Second)
}
