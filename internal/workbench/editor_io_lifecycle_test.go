//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
)

// Queue real worker results so tests can deliver them on the graph in a
// chosen order without relying on disk speed or sleeping.
func editorIOTestHost(t *testing.T) (*editorHost, func() func()) {
	t.Helper()
	posts := make(chan func(), 8)
	cx := core.NewRoot(core.RootOptions{
		CheckCommits: true,
		Post:         func(fn func()) { posts <- fn },
	})
	t.Cleanup(cx.Dispose)
	return newEditorHost(cx), func() func() {
		t.Helper()
		select {
		case fn := <-posts:
			return fn
		case <-time.After(5 * time.Second):
			t.Fatal("file worker did not post its result within 5s")
			return nil
		}
	}
}

func TestEditorReloadIgnoresSupersededReads(t *testing.T) {
	for _, result := range []struct {
		name       string
		oldMissing bool
		newMissing bool
	}{
		{name: "both-succeed"},
		{name: "old-read-fails", oldMissing: true},
		{name: "latest-read-fails", newMissing: true},
	} {
		for _, oldFirst := range []bool{false, true} {
			order := "latest-first"
			if oldFirst {
				order = "old-first"
			}
			t.Run(result.name+"/"+order, func(t *testing.T) {
				h, nextResult := editorIOTestHost(t)
				root := t.TempDir()
				path := filepath.Join(root, "note.txt")
				if !result.oldMissing {
					if err := os.WriteFile(path, []byte("old\r\n"), 0o600); err != nil {
						t.Fatal(err)
					}
				}
				h.openFile(root, path)
				f := h.activeFile()
				old := nextResult()

				if result.newMissing {
					if err := os.Remove(path); err != nil {
						t.Fatal(err)
					}
				} else if err := os.WriteFile(path, []byte("latest\n"), 0o600); err != nil {
					t.Fatal(err)
				}
				a := &app{editor: h}
				a.reloadActiveFile()
				latest := nextResult()
				if oldFirst {
					old()
					if !f.Loading.GetUntracked() || f.Text.GetUntracked() != "" || f.Err.GetUntracked() != "" {
						t.Fatalf("old read published while latest read was pending: loading=%v text=%q error=%q",
							f.Loading.GetUntracked(), f.Text.GetUntracked(), f.Err.GetUntracked())
					}
				}
				latest()
				if f.Loading.GetUntracked() {
					t.Fatal("latest result left the editor loading")
				}
				if result.newMissing {
					if f.Err.GetUntracked() == "" {
						t.Fatal("latest missing file did not report an error")
					}
				} else {
					if got := f.Text.GetUntracked(); got != "latest\n" {
						t.Fatalf("latest text = %q, want %q", got, "latest\n")
					}
					f.Text.Set("unsaved\n")
					f.Dirty.Set(true)
				}
				wantText, wantError := f.Text.GetUntracked(), f.Err.GetUntracked()
				wantDirty := f.Dirty.GetUntracked()
				wantSaved, wantRevision, wantCRLF := f.saved, f.revision, f.crlf
				if !oldFirst {
					old()
				}
				if f.Text.GetUntracked() != wantText || f.Dirty.GetUntracked() != wantDirty ||
					f.Err.GetUntracked() != wantError || f.Loading.GetUntracked() ||
					f.saved != wantSaved || f.revision != wantRevision || f.crlf != wantCRLF {
					t.Fatalf("old read replaced the latest buffer: text=%q dirty=%v error=%q saved=%q crlf=%v",
						f.Text.GetUntracked(), f.Dirty.GetUntracked(), f.Err.GetUntracked(), f.saved, f.crlf)
				}
				if result.newMissing {
					return
				}
				h.save(f)
				nextResult()()
				data, err := os.ReadFile(path)
				if err != nil || string(data) != "unsaved\n" || f.Dirty.GetUntracked() {
					t.Fatalf("save after reload = %q, %v, dirty=%v; want unsaved LF text saved", data, err, f.Dirty.GetUntracked())
				}
			})
		}
	}
}
