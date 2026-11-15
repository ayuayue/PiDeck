package main

// Checks quick open: ranking files by name, and opening one from the
// keyboard.

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/nsgotest"
)

// TestFileMatches checks names beat paths, and shorter paths come first.
func TestFileMatches(t *testing.T) {
	files := []string{"app/main.go", "docs/main-notes.md", "src/readme.md", "main.go", "lib/util.go"}
	got := fileMatches(files, "main", 10)
	want := []string{"main.go", "app/main.go", "docs/main-notes.md"}
	if !slices.Equal(got, want) {
		t.Fatalf("fileMatches = %v, want %v", got, want)
	}
	if got := fileMatches(files, "read", 10); !slices.Equal(got, []string{"src/readme.md"}) {
		t.Fatalf("readme match = %v", got)
	}
	// A path that only contains the query comes last, and the limit holds.
	if got := fileMatches(files, "lib", 1); !slices.Equal(got, []string{"lib/util.go"}) {
		t.Fatalf("path match = %v", got)
	}
	if got := fileMatches(files, "", 2); len(got) != 2 {
		t.Fatalf("empty query = %v, want two", got)
	}
}

// TestQuickOpenFile opens a file by typing part of its name.
func TestQuickOpenFile(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir := editorWorkspace(t)
	write := func(name, body string) {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("note.txt", "hello")
	write("main.go", "package main // root file")
	write("app/main.go", "package app // nested file")
	write("docs/readme.md", "# readme")

	app := startApp(t, dir, 1280, 860)
	app.Key("mod+p")
	app.WaitFor("id:quick-open", 5*time.Second)
	app.WaitUntil(15*time.Second, func() bool { return len(app.Query("role:option docs/readme.md")) > 0 })

	// The file named main.go at the root outranks the nested one.
	app.Type("label:文件名", "main")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("role:option main.go")) > 0 })
	if got := app.Query("role:option app/main.go"); len(got) == 0 {
		t.Fatal("the nested main.go should still be listed")
	}
	app.Key("enter")
	app.WaitFor("text:package main // root file", 10*time.Second)
}
