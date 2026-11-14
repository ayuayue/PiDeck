package main

// Checks the drawer's file operations: a new file, a rename and a new
// folder, all through the context menu and the name dialog.

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/oneo-me/nsgo/nsgotest"
)

func TestFileNameProblem(t *testing.T) {
	cases := map[string]bool{
		"ok.txt": true, "a b": true, "中文.md": true,
		"": false, ".": false, "..": false, "a/b": false, `a\b`: false,
	}
	for name, ok := range cases {
		if got := fileNameProblem(name) == ""; got != ok {
			t.Errorf("fileNameProblem(%q) ok = %v", name, got)
		}
	}
}

func TestFileTreeOps(t *testing.T) {
	if testing.Short() || nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir := editorWorkspace(t)
	docs := filepath.Join(dir, "docs")
	if err := os.MkdirAll(docs, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	app := startApp(t, dir, 1280, 860)
	app.Key("mod+j")
	app.WaitFor("id:drawer-tab-files", 5*time.Second)
	app.Press("id:drawer-tab-files")
	app.WaitFor("role:button docs", 5*time.Second)
	app.Press("role:button docs") // expand, so the new file shows under it
	time.Sleep(200 * time.Millisecond)

	// A new file in docs opens in the editor.
	app.RightClick("text:docs")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:新建文件")) > 0 })
	app.Press("role:menuitem 新建文件 >> nth=0")
	app.WaitFor("id:file-op", 5*time.Second)
	app.Type("id:file-op-name", "new.txt")
	app.Press("id:file-op-confirm")
	waitPath(t, filepath.Join(docs, "new.txt"), true)
	waitApp(app, "role:button new.txt", 10*time.Second)

	// Rename follows the file in the tree.
	app.RightClick("role:button new.txt")
	app.WaitUntil(5*time.Second, func() bool { return len(app.Query("text:重命名")) > 0 })
	app.Press("role:menuitem 重命名")
	app.WaitFor("id:file-op", 5*time.Second)
	app.Clear("id:file-op-name")
	app.Type("id:file-op-name", "renamed.txt")
	app.Press("id:file-op-confirm")
	waitPath(t, filepath.Join(docs, "renamed.txt"), true)
	waitPath(t, filepath.Join(docs, "new.txt"), false)
	waitApp(app, "role:button renamed.txt", 10*time.Second)

	// A new folder.
	for i := 0; i < 4; i++ {
		app.RightClick("text:docs")
		if waitQuiet(app, "text:新建文件夹", 2*time.Second) {
			break
		}
	}
	app.WaitUntil(15*time.Second, func() bool { return len(app.Query("text:新建文件夹")) > 0 })
	app.Press("role:menuitem 新建文件夹")
	app.WaitFor("id:file-op", 5*time.Second)
	app.Type("id:file-op-name", "sub")
	app.Press("id:file-op-confirm")
	waitPath(t, filepath.Join(docs, "sub"), true)
}

// waitPath waits for a path to exist or be gone.
func waitPath(t *testing.T, path string, want bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, err := os.Stat(path)
		if exists := err == nil; exists == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s exists != %v", path, want)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
