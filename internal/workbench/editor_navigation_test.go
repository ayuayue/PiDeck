//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestOpenFileAtEditablePreviewOpensTargetAndJumpsToLine(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless editor navigation regression")
	}
	for _, filename := range []string{"README.md", "page.html", "data.csv"} {
		t.Run(filename, func(t *testing.T) {
			for _, withOpenFile := range []bool{false, true} {
				name := "without-open-file"
				if withOpenFile {
					name = "with-open-file"
				}
				t.Run(name, func(t *testing.T) {
					a, screen, sess := chatDesignFixture(t, 0)
					root := sess.WS
					path := filepath.Join(root, filename)
					text := strings.Repeat("target line\n", 100)
					if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
						t.Fatal(err)
					}
					var old *editorFile
					if withOpenFile {
						oldPath := filepath.Join(root, "old.txt")
						if err := os.WriteFile(oldPath, []byte("old file"), 0o600); err != nil {
							t.Fatal(err)
						}
						screen.Post(func() { a.openEditorFile(root, oldPath) })
						screen.WaitFor("id:editor", 5*time.Second)
						screen.Type("id:editor", "unsaved ")
						old = a.editor.activeFile()
					}

					screen.Post(func() { a.openFileAt(root, path, 80) })
					screen.WaitUntil(5*time.Second, func() bool {
						f := a.editor.activeFile()
						return f != nil && f.Path == path && !f.Loading.GetUntracked()
					})
					screen.WaitFor("id:editor", 5*time.Second)
					f := a.editor.activeFile()
					if f.Text.GetUntracked() != text || !a.editorOpen() || a.activePane.GetUntracked() != "" {
						t.Fatal("positioned text did not open its complete contents in the editor")
					}
					screen.WaitUntil(5*time.Second, func() bool {
						selections := f.ref.Selections()
						return len(selections) > 0 && selections[len(selections)-1].Head.Line == 79
					})
					selections := f.ref.Selections()
					if len(selections) == 0 || selections[len(selections)-1].Head.Line != 79 {
						t.Fatalf("selection = %+v, want line 80 (zero-based 79)", selections)
					}
					if old != nil && (old.Text.GetUntracked() != "unsaved old file" || !old.Dirty.GetUntracked()) {
						t.Fatal("opening a positioned file lost the previous file's unsaved text")
					}
				})
			}
		})
	}
}

func TestOpenFileAtKeepsPreviewForUnpositionedTextAndBinary(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless editor navigation regression")
	}
	for _, tc := range []struct {
		name string
		kind string
		line int
	}{
		{name: "README.md", kind: previewMarkdown},
		{name: "archive.zip", kind: previewBinary, line: 80},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, screen, sess := chatDesignFixture(t, 0)
			path := filepath.Join(sess.WS, tc.name)
			if err := os.WriteFile(path, []byte("preview contents"), 0o600); err != nil {
				t.Fatal(err)
			}
			screen.Post(func() { a.openFileAt(sess.WS, path, tc.line) })
			screen.WaitFor("id:file-preview", 5*time.Second)
			screen.WaitUntil(5*time.Second, func() bool {
				p := a.preview.GetUntracked()
				return p != nil && !p.loading
			})
			p := a.preview.GetUntracked()
			if p.path != path || p.kind != tc.kind || p.err != "" {
				t.Fatalf("preview = %+v, want %s with kind %s", p, path, tc.kind)
			}
			if len(a.editor.files.GetUntracked()) != 0 || a.editorOpen() {
				t.Fatal("a file that belongs in the preview opened an editor tab")
			}
		})
	}
}
