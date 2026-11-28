//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestEditorRenameRefreshesTabsAndKeepsUnsavedText(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless editor rename regression")
	}
	for _, active := range []bool{true, false} {
		name := "inactive"
		if active {
			name = "active"
		}
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			oldPath := filepath.Join(root, "before.txt")
			nextPath := filepath.Join(root, "after.md")
			otherPath := filepath.Join(root, "other.txt")
			for path, text := range map[string]string{oldPath: "alpha", otherPath: "beta"} {
				if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			var a *app
			screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
				a = &app{
					cx: cx, editor: newEditorHost(cx),
					editorFont: core.NewSignal(cx, 13.0),
					editorWrap: core.NewSignal(cx, false),
				}
				return a.editorPane()
			}, nsgotest.Size(900, 500))
			screen.Post(func() { a.editor.openFile(root, oldPath) })
			screen.WaitFor("id:editor", 5*time.Second)
			screen.Type("id:editor", "!")
			renamed := a.editor.activeFile()
			if !active {
				screen.Post(func() { a.editor.openFile(root, otherPath) })
				screen.WaitFor("text:beta", 5*time.Second)
			}

			if err := os.Rename(oldPath, nextPath); err != nil {
				t.Fatal(err)
			}
			screen.Post(func() { a.editor.renamePath(oldPath, nextPath) })
			screen.Settle()
			if got := len(screen.Query("role:tab after.md")); got != 1 {
				t.Fatalf("renamed tab count = %d, want 1; the mounted tab still has its old name", got)
			}
			if got := len(screen.Query("role:tab before.txt")); got != 0 {
				t.Fatalf("old tab count = %d, want 0", got)
			}
			if !active && a.editor.activeFile().Path != otherPath {
				t.Fatal("renaming an inactive file changed the active tab")
			}
			if renamed.Text.GetUntracked() != "!alpha" || !renamed.Dirty.GetUntracked() {
				t.Fatalf("rename lost unsaved text: text = %q, dirty = %v", renamed.Text.GetUntracked(), renamed.Dirty.GetUntracked())
			}
			screen.Press("role:tab after.md")
			if a.editor.activeFile() != renamed || renamed.Lang != "markdown" {
				t.Fatal("renamed tab did not keep the same file with its new language")
			}
			screen.Press("id:editor-save")
			screen.WaitUntil(5*time.Second, func() bool { return !renamed.busy.GetUntracked() })
			data, err := os.ReadFile(nextPath)
			if err != nil || string(data) != "!alpha" || renamed.Dirty.GetUntracked() {
				t.Fatalf("saved renamed file = %q, %v; dirty = %v", data, err, renamed.Dirty.GetUntracked())
			}
			if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
				t.Fatalf("save recreated the previous path: %v", err)
			}
		})
	}
}
