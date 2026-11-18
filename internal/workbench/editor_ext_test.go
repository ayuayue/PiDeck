//go:build !js && !android && !ios

package workbench

// Checks for opening files in an external editor.

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// TestEditorCandidates checks the list is filled in.
func TestEditorCandidates(t *testing.T) {
	list := editorCandidates()
	if len(list) < 5 {
		t.Fatalf("candidates = %+v", list)
	}
	for _, e := range list {
		if e.Name == "" || e.Command == "" {
			t.Errorf("candidate = %+v", e)
		}
	}
}

// TestOpenInEditorMissing checks a command that does not exist fails.
func TestOpenInEditorMissing(t *testing.T) {
	a := &app{cfg: config{EditorCommand: "pideck-no-such-editor-xyz"}}
	if err := a.openInEditor("some-file.txt"); err == nil {
		t.Fatal("a missing editor was accepted")
	}
}

// TestOpenInEditorRuns checks the editor command actually starts, through
// a batch file on Windows and a shell script elsewhere.
func TestOpenInEditorRuns(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "marker.txt")
	var script string
	if runtime.GOOS == "windows" {
		script = filepath.Join(dir, "open.bat")
		body := "@echo off\r\n> \"%~dp0marker.txt\" echo opened\r\n"
		if err := os.WriteFile(script, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	} else {
		script = filepath.Join(dir, "open.sh")
		body := "#!/bin/sh\ntouch \"$(dirname \"$0\")/marker.txt\"\n"
		if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	a := &app{cfg: config{EditorCommand: script}}
	if err := a.openInEditor(filepath.Join(dir, "target.txt")); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the editor command did not run")
		}
		time.Sleep(50 * time.Millisecond)
	}
}
