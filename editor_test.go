package main

// Checks for the built-in file editor: the language it gives a file, and
// a file opened, edited, saved and closed through the window.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/nsgotest"
)

// TestEditorLanguage checks the names the highlighter gets.
func TestEditorLanguage(t *testing.T) {
	cases := map[string]string{
		"main.go":           "go",
		"App.tsx":           "tsx",
		"index.mjs":         "javascript",
		"README.md":         "markdown",
		"Dockerfile":        "dockerfile",
		"config.yaml":       "yaml",
		"Makefile":          "makefile",
		"notes.unknown_ext": "unknown_ext",
		"no-extension":      "",
	}
	for path, want := range cases {
		if got := editorLanguage(path); got != want {
			t.Errorf("editorLanguage(%q) = %q, want %q", path, got, want)
		}
	}
}

// TestFileEditorOpenSaveClose drives the drawer's file row into the
// editor, types, saves with the shortcut and comes back to the chat.
func TestFileEditorOpenSaveClose(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir := editorWorkspace(t)
	path := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(path, []byte("hello editor"), 0o644); err != nil {
		t.Fatal(err)
	}
	app := startApp(t, dir, 1280, 860)
	app.Key("mod+j")
	app.WaitFor("id:drawer-tab-files", 5*time.Second)
	app.Press("id:drawer-tab-files")
	app.WaitFor("text:note.txt", 5*time.Second)
	app.Press("text:note.txt")
	app.WaitFor("text:hello editor", 5*time.Second)

	app.Type("id:editor", "!")
	app.Key("mod+s")
	deadline := time.Now().Add(5 * time.Second)
	for {
		data, err := os.ReadFile(path)
		if err == nil && string(data) == "!hello editor" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("file after save = %q, want %q", string(data), "!hello editor")
		}
		time.Sleep(50 * time.Millisecond)
	}

	app.Key("mod+w")
	app.WaitFor("id:composer", 5*time.Second)
	if len(app.Query("id:editor")) != 0 {
		t.Fatal("the editor is still on screen after closing its file")
	}
}

// TestFileEditorUnsavedWarns checks a modified file is not closed without
// asking.
func TestFileEditorUnsavedWarns(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir := editorWorkspace(t)
	path := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(path, []byte("keep me"), 0o644); err != nil {
		t.Fatal(err)
	}
	app := startApp(t, dir, 1280, 860)
	app.Key("mod+j")
	app.WaitFor("id:drawer-tab-files", 5*time.Second)
	app.Press("id:drawer-tab-files")
	app.WaitFor("text:note.txt", 5*time.Second)
	app.Press("text:note.txt")
	app.WaitFor("text:keep me", 5*time.Second)
	app.Type("id:editor", " changed")
	app.Key("mod+w")
	app.WaitFor("id:confirm", 5*time.Second)
	if data, _ := os.ReadFile(path); strings.Contains(string(data), "changed") {
		t.Fatalf("the file was written before the question: %q", data)
	}
	app.Press("id:confirm-ok")
	app.WaitFor("id:composer", 5*time.Second)
}

// editorWorkspace makes a folder a test can open as a project. It is not
// t.TempDir's: a pi process may hold the folder a moment after the test,
// so removal is retried instead of failing the test.
func editorWorkspace(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "pideck-editor-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		for i := 0; i < 40; i++ {
			if os.RemoveAll(dir) == nil {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
	})
	return dir
}
