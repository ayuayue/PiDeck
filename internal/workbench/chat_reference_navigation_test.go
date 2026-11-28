//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestChatReferenceResultKeepsLaterFileNavigation(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless file navigation regression")
	}
	for _, action := range []string{"preview", "editor", "close-preview", "close-editor", "newer-reference", "pane", "session"} {
		t.Run(action, func(t *testing.T) {
			a, screen, sess := chatDesignFixture(t, 0)
			first := filepath.Join(sess.WS, "first.md")
			next := filepath.Join(sess.WS, "next.txt")
			for _, path := range []string{first, next} {
				if err := os.WriteFile(path, []byte("navigation contents"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			screen.Post(func() {
				if action == "close-preview" {
					a.openFilePreview(next, previewMarkdown)
				} else if action == "close-editor" {
					a.openEditorFile(sess.WS, next)
				}
				// The production resolver posts this callback after disk I/O.
				// Deliver it explicitly so the navigation order is deterministic.
				complete := a.chatFileReferenceResult(sess, sess.WS, first, 0)
				switch action {
				case "preview":
					a.openFilePreview(next, previewMarkdown)
				case "editor":
					a.openEditorFile(sess.WS, next)
				case "close-preview":
					a.closeFilePreview()
				case "close-editor":
					a.editor.closeAll()
				case "newer-reference":
					newer := a.chatFileReferenceResult(sess, sess.WS, next, 0)
					newer(next, nil)
				case "pane":
					a.openPane(paneSettings)
				case "session":
					a.activeID.Set("")
				}
				complete(first, nil)
			})
			screen.Settle()
			if action == "preview" {
				p := a.preview.GetUntracked()
				if p == nil || p.path != next || a.activePane.GetUntracked() != panePreview {
					t.Fatalf("late reference replaced the newer preview: %+v", p)
				}
			} else if action == "editor" || action == "newer-reference" {
				screen.WaitUntil(5*time.Second, func() bool {
					f := a.editor.activeFile()
					return f != nil && !f.Loading.GetUntracked()
				})
				f := a.editor.activeFile()
				if f.Path != next || !a.editorOpen() || a.activePane.GetUntracked() != "" {
					t.Fatalf("late reference replaced the newer editor: file=%s pane=%s", f.Path, a.activePane.GetUntracked())
				}
			} else if a.preview.GetUntracked() != nil || a.editorOpen() {
				t.Fatal("late reference reopened the file area after navigation")
			}
			if action == "pane" && a.activePane.GetUntracked() != paneSettings {
				t.Fatal("late reference switched away from the selected pane")
			}
		})
	}
}

func TestChatReferenceResultOnlyLatestRequestCanOpen(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless file navigation regression")
	}
	a, screen, sess := chatDesignFixture(t, 0)
	first := filepath.Join(sess.WS, "first.md")
	next := filepath.Join(sess.WS, "next.md")
	for _, path := range []string{first, next} {
		if err := os.WriteFile(path, []byte("reference contents"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	var latest func(string, error)
	screen.Post(func() {
		older := a.chatFileReferenceResult(sess, sess.WS, first, 0)
		latest = a.chatFileReferenceResult(sess, sess.WS, next, 0)
		older(first, nil)
	})
	screen.Settle()
	if a.preview.GetUntracked() != nil || a.editorOpen() {
		t.Fatal("an older reference opened while the latest request was still resolving")
	}
	screen.Post(func() { latest(next, nil) })
	screen.WaitUntil(5*time.Second, func() bool {
		p := a.preview.GetUntracked()
		return p != nil && !p.loading
	})
	if p := a.preview.GetUntracked(); p.path != next || p.err != "" {
		t.Fatalf("latest reference preview = %+v, want %s", p, next)
	}
}

func TestChatReferenceResultKeepsSelectedEditorTab(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless file navigation regression")
	}
	a, screen, sess := chatDesignFixture(t, 0)
	first := filepath.Join(sess.WS, "first.txt")
	next := filepath.Join(sess.WS, "next.txt")
	for _, path := range []string{first, next} {
		if err := os.WriteFile(path, []byte("editor contents"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	screen.Post(func() {
		a.openEditorFile(sess.WS, first)
		a.openEditorFile(sess.WS, next)
	})
	screen.WaitFor("id:editor", 5*time.Second)
	var complete func(string, error)
	screen.Post(func() {
		complete = a.chatFileReferenceResult(sess, sess.WS, next, 1)
	})
	screen.Press("role:tab first.txt")
	screen.Post(func() { complete(next, nil) })
	screen.Settle()
	if f := a.editor.activeFile(); f == nil || f.Path != first || !a.editorOpen() {
		t.Fatal("late reference replaced the editor tab selected while it was resolving")
	}
}

func TestChatReferenceResultReportsOnlyCurrentErrors(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless file navigation regression")
	}
	for _, stale := range []bool{false, true} {
		name := "current"
		if stale {
			name = "stale"
		}
		t.Run(name, func(t *testing.T) {
			a, screen, sess := chatDesignFixture(t, 0)
			missing := filepath.Join(sess.WS, "missing.md")
			screen.Post(func() {
				complete := a.chatFileReferenceResult(sess, sess.WS, missing, 0)
				if stale {
					_ = a.chatFileReferenceResult(sess, sess.WS, "newer.md", 0)
				}
				complete("", os.ErrNotExist)
			})
			screen.Settle()
			want := 1
			if stale {
				want = 0
			}
			if got := len(screen.Query("text:无法读取文件")); got != want {
				t.Fatalf("read error toast count = %d, want %d", got, want)
			}
		})
	}
}
