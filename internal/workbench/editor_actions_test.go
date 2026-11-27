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

func TestEditorSaveAllAvailability(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless editor action regression")
	}
	dir := t.TempDir()
	aPath, bPath := filepath.Join(dir, "a.txt"), filepath.Join(dir, "b.txt")
	for path, text := range map[string]string{aPath: "alpha", bPath: "beta"} {
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = &app{
			cx: cx, editor: newEditorHost(cx),
			editorFont: core.NewSignal(cx, 13.0),
			editorWrap: core.NewSignal(cx, false),
		}
		return built.editorPane()
	}, nsgotest.Size(900, 500))
	assertSaveAll := func(want bool) {
		t.Helper()
		if got := screen.Enabled("id:editor-save-all"); got != want {
			t.Fatalf("save all enabled = %v, want %v", got, want)
		}
	}
	assertSaved := func(path, want string) {
		t.Helper()
		data, err := os.ReadFile(path)
		if err != nil || string(data) != want {
			t.Fatalf("saved file %s = %q, %v; want %q", filepath.Base(path), data, err, want)
		}
	}

	assertSaveAll(false)
	screen.Post(func() { built.editor.openFile(dir, aPath) })
	screen.WaitFor("id:editor", 5*time.Second)
	assertSaveAll(false)
	screen.Type("id:editor", "!")
	assertSaveAll(true)
	screen.Press("id:editor-save-all")
	screen.WaitUntil(5*time.Second, func() bool { return !built.editor.anyDirty() })
	assertSaveAll(false)
	assertSaved(aPath, "!alpha")

	screen.Post(func() { built.editor.openFile(dir, bPath) })
	screen.WaitFor("text:beta", 5*time.Second)
	screen.Type("id:editor", "?")
	assertSaveAll(true)
	screen.Press("role:tab a.txt")
	// A clean active tab must not hide changes in another open file.
	if screen.Enabled("id:editor-save") {
		t.Fatal("the active clean file can be saved")
	}
	assertSaveAll(true)
	screen.Press("id:editor-save-all")
	screen.WaitUntil(5*time.Second, func() bool { return !built.editor.anyDirty() })
	assertSaveAll(false)
	assertSaved(bPath, "?beta")

	screen.Type("id:editor", "*")
	assertSaveAll(true)
	// Removing the only dirty tab must refresh the mounted action too.
	screen.Post(func() { built.editor.close(aPath) })
	screen.Settle()
	assertSaveAll(false)
}
