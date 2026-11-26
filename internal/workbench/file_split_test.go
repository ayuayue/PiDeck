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

func TestFileWorkspaceRightSplit(t *testing.T) {
	a, screen, sess := chatDesignFixture(t, 0)
	textPath := filepath.Join(sess.WS, "note.txt")
	markdownPath := filepath.Join(sess.WS, "README.md")
	for path, text := range map[string]string{textPath: "original text", markdownPath: "# Preview\n\nFile preview body.\n"} {
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	composer := screen.Find("id:composer")
	screen.Type("id:composer", "keep this draft")
	fullWidth := screen.Find("id:transcript").Bounds().Size.Width

	screen.Post(func() { a.openEditorFile(sess.WS, textPath) })
	screen.WaitFor("id:editor", 5*time.Second)
	assertFileRightSplit(t, screen, "id:editor-pane")
	if got := screen.Find("id:composer"); got.ID != composer.ID || got.Text != "keep this draft" {
		t.Fatalf("opening a file replaced the conversation input: id=%v, text=%q", got.ID, got.Text)
	}
	screen.Resize(1600, 860)
	beforeDrag := screen.Find("id:file-panel").Bounds()
	screen.Drag("id:file-workspace-handle-0", core.Point{X: -80})
	if got := screen.Find("id:file-panel").Bounds(); got.Origin.X >= beforeDrag.Origin.X || got.Size.Width <= beforeDrag.Size.Width {
		t.Fatalf("dragging the divider did not widen the file panel: %v -> %v", beforeDrag, got)
	}
	screen.Type("id:editor", "changed ")
	var dirty *editorFile
	screen.Post(func() { dirty = a.editor.activeFile() })
	screen.Settle()

	// Previewing and editing share the same right-hand panel and divider.
	screen.Post(func() { a.openEditorFile(sess.WS, markdownPath) })
	screen.WaitFor("text:File preview body.", 5*time.Second)
	assertFileRightSplit(t, screen, "id:file-preview")
	previewBounds := screen.Find("id:file-panel").Bounds()
	shot(screen, "file-split/preview-light")
	screen.Press("id:preview-edit-text")
	screen.WaitFor("id:editor", 5*time.Second)
	assertFileRightSplit(t, screen, "id:editor-pane")
	if got := screen.Find("id:file-panel").Bounds(); got != previewBounds {
		t.Errorf("switching preview to editing moved the file panel: %v -> %v", previewBounds, got)
	}
	screen.Post(func() {
		if !dirty.Dirty.GetUntracked() || dirty.Text.GetUntracked() != "changed original text" {
			t.Errorf("opening a preview lost unsaved text: dirty=%v, text=%q", dirty.Dirty.GetUntracked(), dirty.Text.GetUntracked())
		}
		a.closeEditorPane()
	})
	screen.WaitFor("id:confirm", 5*time.Second)
	screen.Press("id:confirm-cancel")
	screen.WaitForGone("id:confirm", 5*time.Second)
	assertFileRightSplit(t, screen, "id:editor-pane")
	if got := screen.Find("id:composer"); got.ID != composer.ID {
		t.Errorf("switching between preview and editing replaced the conversation input: %v -> %v", composer.ID, got.ID)
	}
	shot(screen, "file-split/editor-light")

	screen.Post(func() { a.theme.Set("dark"); a.applyTheme() })
	screen.Resize(1080, 760)
	assertFileRightSplit(t, screen, "id:editor-pane")
	shot(screen, "file-split/editor-dark-narrow")
	// Changing the theme rebuilds the shell; closing a split must not.
	composer = screen.Find("id:composer")
	screen.Post(func() { a.closeEditorPane() })
	screen.WaitFor("id:confirm", 5*time.Second)
	screen.Press("id:confirm-ok")
	screen.WaitForGone("id:editor", 5*time.Second)
	screen.Resize(1320, 860)
	screen.WaitUntil(5*time.Second, func() bool { return screen.Find("id:transcript").Bounds().Size.Width == fullWidth })
	if got := screen.Find("id:composer"); got.ID != composer.ID || got.Text != "keep this draft" {
		t.Errorf("closing the file panel replaced the conversation input: id=%v, text=%q", got.ID, got.Text)
	}
}

func TestFileWorkspacePreviewErrorAndClose(t *testing.T) {
	a, screen, sess := chatDesignFixture(t, 0)
	screen.Post(func() { a.openFilePreview(filepath.Join(sess.WS, "missing.md"), previewMarkdown) })
	screen.WaitUntil(5*time.Second, func() bool {
		p := a.preview.GetUntracked()
		return p != nil && !p.loading && p.err != ""
	})
	assertFileRightSplit(t, screen, "id:file-preview")
	screen.Press("id:file-preview-close")
	screen.WaitForGone("id:file-preview", 5*time.Second)
	screen.Post(func() {
		if a.preview.GetUntracked() != nil || a.activePane.GetUntracked() != "" {
			t.Error("closing the preview kept its state or active pane")
		}
	})
	screen.WaitFor("id:composer", 5*time.Second)
}

func assertFileRightSplit(t *testing.T, screen *nsgotest.App, selector string) {
	t.Helper()
	screen.WaitFor("id:composer", 5*time.Second)
	screen.Settle()
	chat, file := screen.Find("id:transcript").Bounds(), screen.Find(selector).Bounds()
	if chat.Size.Width < 250 || file.Size.Width < 250 || file.Origin.X < chat.Origin.X+chat.Size.Width || file.Size.Height <= 0 {
		t.Fatalf("file must share the work area to the right of the conversation: chat=%v file=%v", chat, file)
	}
	input := screen.Find("id:composer").Bounds()
	if input.Origin.X+input.Size.Width > file.Origin.X+core.Points(1) {
		t.Errorf("conversation input overlaps the file panel: input=%v file=%v", input, file)
	}
}
