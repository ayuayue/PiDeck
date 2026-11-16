package main

// Checks the editor keeps a file's CRLF line endings when saving.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestFileEditorKeepsCRLF(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir := editorWorkspace(t)
	path := filepath.Join(dir, "note.txt")
	original := "one\r\ntwo\r\n"
	if err := os.WriteFile(path, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	app := startApp(t, dir, 1280, 860)
	app.Key("mod+j")
	app.WaitFor("id:drawer-tab-files", 5*time.Second)
	app.Press("id:drawer-tab-files")
	app.WaitFor("text:note.txt", 5*time.Second)
	app.Press("text:note.txt")
	app.WaitFor("text:one", 5*time.Second)

	app.Type("id:editor", "!")
	app.Key("mod+s")
	deadline := time.Now().Add(5 * time.Second)
	for {
		data, err := os.ReadFile(path)
		if err == nil && strings.Contains(string(data), "!") {
			if !strings.Contains(string(data), "one\r\ntwo") {
				t.Fatalf("file after save = %q, want CRLF kept", string(data))
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("file after save = %q, %v", string(data), err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
