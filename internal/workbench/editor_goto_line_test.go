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

func TestGoToLineDialogKeepsCaretAndReturnsFocus(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless editor dialog regression")
	}
	for _, tc := range []struct {
		name      string
		dismiss   func(*nsgotest.App)
		line      int
		column    int
		wantCaret string
	}{
		{name: "return", dismiss: func(s *nsgotest.App) { s.Submit("id:goto-line-input") }, line: 3, column: 4, wantCaret: "4:1"},
		{name: "button", dismiss: func(s *nsgotest.App) { s.Press("id:goto-line-go") }, line: 3, column: 4, wantCaret: "4:1"},
		{name: "cancel", dismiss: func(s *nsgotest.App) { s.Key("escape") }, column: 3, wantCaret: "1:1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, screen, sess := chatDesignFixture(t, 0)
			path := filepath.Join(sess.WS, "note.txt")
			if err := os.WriteFile(path, []byte("one\ntwo\nthree\nfour\nfive\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			screen.Post(func() { a.openEditorFile(sess.WS, path) })
			screen.WaitFor("id:editor", 5*time.Second)
			f := a.editor.activeFile()
			screen.Key("mod+g")
			screen.WaitFor("id:goto-line-input", 5*time.Second)
			screen.Type("id:goto-line-input", "4")
			tc.dismiss(screen)
			screen.WaitUntil(5*time.Second, func() bool { return len(screen.Query("id:goto-line")) == 0 })
			if sels := f.ref.Selections(); len(sels) != 1 || sels[0].Head.Line != tc.line || f.caret.GetUntracked() != tc.wantCaret || a.gotoOpen.GetUntracked() {
				t.Fatalf("dialog did not keep the expected caret %s: selection=%+v caret=%s dialog=%v", tc.wantCaret, sels, f.caret.GetUntracked(), a.gotoOpen.GetUntracked())
			}
			screen.Key("end")
			if sels := f.ref.Selections(); len(sels) != 1 || sels[0].Head.Line != tc.line || sels[0].Head.Column != tc.column {
				t.Fatalf("editor did not receive End after the dialog closed: selection=%+v", sels)
			}
		})
	}
}

func TestEditorStatusFitsNarrowPaneWithLongPath(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless editor status layout regression")
	}
	a, screen, sess := chatDesignFixture(t, 0)
	screen.Resize(980, 860)
	dir := filepath.Join(sess.WS, strings.Repeat("long-directory-", 5))
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(path, []byte("one\ntwo\nthree\nfour\nfive\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	screen.Post(func() { a.openEditorFile(sess.WS, path) })
	screen.WaitFor("id:editor", 5*time.Second)
	screen.Post(func() { a.gotoLine.Set("4"); a.jumpToLine() })
	screen.Settle()
	pane := screen.Find("id:editor-pane").Bounds()
	if pane.Size.Width > 400 {
		t.Fatalf("regression needs a narrow editor pane, got %+v", pane)
	}
	for _, selector := range []string{"text:4:1", "id:editor-lines"} {
		matches := screen.Query(selector)
		if len(matches) != 1 {
			t.Fatalf("status %s is not visible in the narrow editor pane: matches=%d", selector, len(matches))
		}
		b := matches[0].Bounds()
		if b.Origin.X < pane.Origin.X || b.Origin.X+b.Size.Width > pane.Origin.X+pane.Size.Width-10+1 {
			t.Fatalf("status %s overflows the editor pane: status=%+v pane=%+v", selector, b, pane)
		}
	}
}
