//go:build !js && !android && !ios

package workbench

// Checks quick open: ranking files by name, and opening one from the
// keyboard.

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
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

// TestPushRecent checks the recent list keeps one of each path, newest
// first, and stays bounded.
func TestPushRecent(t *testing.T) {
	if got := pushRecent([]string{"/a", "/b", "/a"}, "/c", 3); !slices.Equal(got, []string{"/c", "/a", "/b"}) {
		t.Fatalf("pushRecent = %v", got)
	}
	if got := pushRecent([]string{"/a", "/b"}, "/c", 2); !slices.Equal(got, []string{"/c", "/a"}) {
		t.Fatalf("bounded pushRecent = %v", got)
	}
	if got := pushRecent([]string{"/a"}, "", 3); !slices.Equal(got, []string{"/a"}) {
		t.Fatalf("empty pushRecent = %v", got)
	}
}

// TestQuickOpenRecents opens a file and finds it under 最近 in quick open.
func TestQuickOpenRecents(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir := editorWorkspace(t)
	for _, name := range []string{"note.txt", "other.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("hello "+name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	app := startApp(t, dir, 1280, 860)
	app.Key("mod+j")
	app.WaitFor("id:drawer-tab-files", 5*time.Second)
	app.Press("id:drawer-tab-files")
	app.WaitFor("text:note.txt", 5*time.Second)
	app.Press("text:note.txt")
	app.WaitFor("id:editor", 5*time.Second)

	app.Key("mod+p")
	app.WaitFor("id:quick-open", 5*time.Second)
	app.WaitUntil(10*time.Second, func() bool { return len(app.Query("text:最近")) > 0 })
	app.WaitFor("role:option note.txt", 5*time.Second)

	deadline := time.Now().Add(5 * time.Second)
	for {
		raw, err := os.ReadFile(filepath.Join(home, "config.json"))
		if err == nil && strings.Contains(string(raw), "recentFiles") && strings.Contains(string(raw), "note.txt") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("config = %s, %v", raw, err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// TestPaletteRecentFile reaches a recently opened file from the command
// palette.
func TestPaletteRecentFile(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello palette"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "other.txt"), []byte("other"), 0o644); err != nil {
		t.Fatal(err)
	}
	app := startApp(t, dir, 1280, 860)
	app.Key("mod+j")
	app.WaitFor("id:drawer-tab-files", 5*time.Second)
	app.Press("id:drawer-tab-files")
	app.WaitFor("text:note.txt", 5*time.Second)
	app.Press("text:note.txt")
	app.WaitFor("id:editor", 5*time.Second)
	app.Key("mod+w")
	app.WaitFor("id:composer", 5*time.Second)

	app.Key("mod+k")
	app.Type("label:命令", "note.txt")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("role:option note.txt")) > 0 })
	app.Press("role:option note.txt")
	app.WaitFor("text:hello palette", 10*time.Second)
}
