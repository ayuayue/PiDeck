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
	pickMenu(t, app, "role:button docs", "新建文件")
	app.Type("id:file-op-name", "new.txt")
	app.Press("id:file-op-confirm")
	waitPath(t, filepath.Join(docs, "new.txt"), true)
	waitApp(app, "role:button new.txt", 10*time.Second)

	// Rename follows the file in the tree.
	pickMenu(t, app, "role:button new.txt", "重命名")
	app.Clear("id:file-op-name")
	app.Type("id:file-op-name", "renamed.txt")
	app.Press("id:file-op-confirm")
	waitPath(t, filepath.Join(docs, "renamed.txt"), true)
	waitPath(t, filepath.Join(docs, "new.txt"), false)
	waitApp(app, "role:button renamed.txt", 10*time.Second)

	// A new folder.
	openMenu(t, app, "role:button docs", "新建文件夹")
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

// TestFileTrash moves a file to the data folder's trash.
func TestFileTrash(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	dir := editorWorkspace(t)
	for _, name := range []string{"note.txt", "extra.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("hello"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	app := startApp(t, dir, 1280, 860)
	app.Key("mod+j")
	app.WaitFor("id:drawer-tab-files", 5*time.Second)
	app.Press("id:drawer-tab-files")
	app.WaitFor("text:extra.txt", 10*time.Second)
	for i := 0; i < 4; i++ {
		app.RightClick("text:extra.txt")
		if waitQuiet(app, "text:移到回收站", 2*time.Second) {
			break
		}
	}
	app.Press("text:移到回收站")
	app.WaitFor("id:confirm-ok", 5*time.Second)
	app.Press("id:confirm-ok")
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(dir, "extra.txt")); os.IsNotExist(err) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("extra.txt was not moved")
		}
		time.Sleep(50 * time.Millisecond)
	}
	entries, err := os.ReadDir(filepath.Join(home, "trash", "files"))
	if err != nil || len(entries) != 1 {
		t.Fatalf("trash = %v, %v", entries, err)
	}
}

// openMenu right-clicks a row until its menu item is there to press: the
// press that expanded a folder can swallow the next one.
func openMenu(t *testing.T, app *nsgotest.App, trigger, item string) {
	t.Helper()
	for i := 0; i < 6; i++ {
		if len(app.Query("role:menuitem "+item)) > 0 {
			return
		}
		app.RightClick(trigger)
		app.Settle()
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("menu item %q did not open on %s", item, trigger)
}

// pickMenu opens a row's menu and presses an item, retrying while the
// tree's rebuild closes the menu under it.
func pickMenu(t *testing.T, app *nsgotest.App, trigger, item string) {
	t.Helper()
	for i := 0; i < 8; i++ {
		openMenu(t, app, trigger, item)
		if len(app.Query("role:menuitem "+item)) == 0 {
			continue
		}
		app.Press("role:menuitem " + item + " >> nth=0")
		app.Settle()
		if len(app.Query("id:file-op")) > 0 {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("menu item %q on %s opened nothing", item, trigger)
}
