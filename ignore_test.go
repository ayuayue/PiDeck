package main

// Checks adding a file to .gitignore from the file tree.

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/nsgotest"
)

func TestAppendGitignore(t *testing.T) {
	dir := t.TempDir()
	if err := appendGitignore(dir, "a.txt"); err != nil {
		t.Fatal(err)
	}
	read := func() string {
		raw, err := os.ReadFile(filepath.Join(dir, ".gitignore"))
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	if got := read(); got != "a.txt\n" {
		t.Fatalf(".gitignore = %q", got)
	}
	if err := appendGitignore(dir, "a.txt"); err != nil {
		t.Fatal(err)
	}
	if got := read(); got != "a.txt\n" {
		t.Fatalf("duplicate .gitignore = %q", got)
	}
	if err := appendGitignore(dir, "b.txt"); err != nil {
		t.Fatal(err)
	}
	if got := read(); got != "a.txt\nb.txt\n" {
		t.Fatalf(".gitignore = %q", got)
	}
	// A file without a trailing newline still gets a clean line.
	if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := appendGitignore(dir, "y"); err != nil {
		t.Fatal(err)
	}
	if got := read(); got != "x\ny\n" {
		t.Fatalf(".gitignore = %q", got)
	}
}

func TestIgnoreFileFromTree(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "secret.txt"), []byte("key"), 0o644); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("git", "-C", dir, "init").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, out)
	}

	app := startApp(t, dir, 1280, 860)
	app.Key("mod+j")
	app.WaitFor("id:drawer-tab-files", 5*time.Second)
	app.Press("id:drawer-tab-files")
	app.WaitFor("role:button secret.txt", 10*time.Second)
	openMenu(t, app, "role:button secret.txt", "加入 .gitignore")
	app.Press("role:menuitem 加入 .gitignore")

	deadline := time.Now().Add(10 * time.Second)
	for {
		raw, err := os.ReadFile(filepath.Join(dir, ".gitignore"))
		if err == nil && strings.Contains(string(raw), "secret.txt") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf(".gitignore = %q, %v", string(raw), err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	out, err := exec.Command("git", "-C", dir, "status", "--porcelain").CombinedOutput()
	if err != nil {
		t.Fatalf("git status: %v: %s", err, out)
	}
	if strings.Contains(string(out), "secret.txt") {
		t.Fatalf("status still lists the file: %s", out)
	}
}
