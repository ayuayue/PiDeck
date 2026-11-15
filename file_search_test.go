package main

// Checks find in files: what it matches, and opening a hit at its line.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/nsgotest"
)

// TestSearchWorkspace checks the matching rules: case, limits, and the
// files it leaves out.
func TestSearchWorkspace(t *testing.T) {
	dir := t.TempDir()
	write := func(rel, body string) {
		path := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("a.txt", "hello\nworld hello\n")
	write("b.txt", "HELLO there")
	write("node_modules/c.txt", "hello")
	write("bin.dat", "he\x00llo")
	write("big.txt", strings.Repeat("x", fileSearchMaxBytes+1))

	hits := searchWorkspace(dir, walkWorkspaceFiles(dir), "hello")
	if len(hits) != 3 {
		t.Fatalf("hits = %d (%v), want 3", len(hits), hits)
	}
	if hits[0].File != "a.txt" || hits[0].Line != 1 || hits[0].Col != 1 {
		t.Fatalf("first hit = %+v", hits[0])
	}
	if hits[1].Line != 2 || hits[1].Col != 7 {
		t.Fatalf("second hit = %+v", hits[1])
	}
	if hits[2].File != "b.txt" {
		t.Fatalf("case-insensitive hit = %+v", hits[2])
	}

	// A file contributes at most fileSearchPerFile matches.
	var many []string
	for i := 0; i < fileSearchPerFile+3; i++ {
		many = append(many, "needle")
	}
	write("many.txt", strings.Join(many, "\n"))
	hits = searchWorkspace(dir, []string{"many.txt"}, "needle")
	if len(hits) != fileSearchPerFile {
		t.Fatalf("per-file hits = %d, want %d", len(hits), fileSearchPerFile)
	}

	if hits := searchWorkspace(dir, []string{"a.txt"}, "  "); hits != nil {
		t.Fatalf("blank query = %v, want none", hits)
	}
	if got := hitText(strings.Repeat("界", 10), 4); got != "界界界界…" {
		t.Fatalf("hitText = %q", got)
	}
}

// TestFileSearchOpensHit searches the project and opens a match at its line.
func TestFileSearchOpensHit(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir := editorWorkspace(t)
	write := func(rel, body string) {
		path := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("note.txt", "hello")
	write("src/app.go", "package main\n\nfunc target() {}\n")

	app := startApp(t, dir, 1280, 860)
	app.Key("mod+alt+f")
	app.WaitFor("id:file-search-input", 5*time.Second)
	app.Type("id:file-search-input", "target")
	app.Submit("id:file-search-input")
	app.WaitUntil(15*time.Second, func() bool { return len(app.Query("id:file-search-hit")) > 0 })
	app.Press("id:file-search-hit >> nth=0")
	app.WaitFor("text:func target() {}", 10*time.Second)
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:3:1")) > 0 })
}
