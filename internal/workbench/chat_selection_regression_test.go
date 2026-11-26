//go:build !js && !android && !ios

package workbench

import (
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestChatSelectionCopiesAfterComposerFocus(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless selection contract; native test drives the mouse")
	}
	screen, _, s, _ := chatSelectionFixture(t)
	s.draft.Set("keep this draft")
	screen.Press("id:composer")
	screen.Select("id:composer", 0, 4)
	screen.Clipboard = "before selection"
	selectChatParagraph(t, screen)
	screen.Key("mod+c")
	if screen.Clipboard != selectionParagraph {
		t.Fatalf("copy after typing = %q, want selected reply %q", screen.Clipboard, selectionParagraph)
	}
	if s.draft.GetUntracked() != "keep this draft" {
		t.Fatal("copy changed the draft")
	}
	// Returning to the input must restore its normal editing shortcuts.
	screen.Press("id:composer")
	screen.Select("id:composer", 0, 4)
	screen.Key("mod+c")
	if screen.Clipboard != "keep" {
		t.Fatalf("input copy = %q, want its own selection", screen.Clipboard)
	}
}

func TestChatSelectionContextCopyAndQuote(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless selection contract; native test drives the mouse")
	}
	for _, action := range []string{"copy", "quote"} {
		t.Run(action, func(t *testing.T) {
			screen, a, s, _ := chatSelectionFixture(t)
			s.draft.Set("unfinished draft")
			screen.Clipboard = "unchanged clipboard"
			selectChatParagraph(t, screen)
			screen.RightClick("text:" + selectionParagraph)
			screen.WaitFor("id:chat-selection-"+action, time.Second)
			// Native mouse-down may clear the highlight before menu activation.
			screen.SelectText("id:transcript-column", core.Bounds{})
			screen.Press("id:chat-selection-" + action)
			if action == "copy" {
				if screen.Clipboard != selectionParagraph || s.draft.GetUntracked() != "unfinished draft" {
					t.Fatalf("selection copy: clipboard=%q draft=%q", screen.Clipboard, s.draft.GetUntracked())
				}
			} else if got, want := s.draft.GetUntracked(), "unfinished draft\n> "+selectionParagraph+"\n\n"; got != want {
				t.Fatalf("quote = %q, want %q", got, want)
			} else if screen.Clipboard != "unchanged clipboard" {
				t.Fatal("quoting changed the clipboard")
			}
			if a.translation.GetUntracked() != nil {
				t.Fatal("selection action opened translation")
			}
			screen.RightClick("id:chat-reply")
			if len(screen.Query("id:chat-selection-copy")) != 0 || len(screen.Query("id:chat-selection-quote")) != 0 {
				t.Fatal("context menu reused a cleared selection")
			}
		})
	}
}

func TestChatSelectionActionUsesMousePosition(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless pointer placement contract")
	}
	screen, _, _, _ := chatSelectionFixture(t)
	text := screen.Find("text:" + selectionParagraph).Bounds()
	at := core.Point{X: 160, Y: text.Size.Height / 2}
	screen.HoverAt("text:"+selectionParagraph, at)
	selectChatParagraph(t, screen)
	button := screen.Find("id:chat-selection-translate").Bounds()
	pointer := core.Point{X: text.Origin.X + at.X, Y: text.Origin.Y + at.Y}
	if button.Origin.X < pointer.X-8 || button.Origin.X > pointer.X+16 || button.Origin.Y < pointer.Y || button.Origin.Y > pointer.Y+24 {
		t.Fatalf("translation action %v is not beside mouse %v", button, pointer)
	}
	screen.Hover("id:chat-selection-translate")
	if got := screen.Find("id:chat-selection-translate").Bounds(); got != button {
		t.Fatalf("moving to translation moved its target: before=%v after=%v", button, got)
	}
}

func TestNativeChatSelectionCopyAndQuote(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native input focus and mouse selection")
	}
	screen, a, s, _ := chatSelectionFixture(t)
	onNativeUI(t, screen, a, func() {
		s.draft.Set("keep this draft")
		a.cx.SetClipboard("before selection")
	})
	screen.Press("id:composer")
	screen.DragAt("text:"+selectionParagraph, core.Point{X: 2, Y: 12}, core.Point{X: 130})
	screen.WaitFor("id:chat-selection-translate", 5*time.Second)
	screen.Key("mod+c")
	clipboard := make(chan string, 1)
	onNativeUI(t, screen, a, func() { a.cx.ReadClipboard(func(text string) { clipboard <- text }) })
	var copied string
	select {
	case copied = <-clipboard:
	case <-time.After(5 * time.Second):
		t.Fatal("clipboard read did not complete")
	}
	if strings.TrimSpace(copied) == "" || copied == selectionParagraph || !strings.Contains(selectionParagraph, copied) {
		t.Fatalf("native copy after input focus = %q, want part of %q", copied, selectionParagraph)
	}
	screen.RightClick("text:" + selectionParagraph)
	screen.WaitFor("id:chat-selection-quote", 5*time.Second)
	shot(screen, "selection/context-copy-quote")
	screen.Press("id:chat-selection-quote")
	onNativeUI(t, screen, a, func() {
		if got, want := s.draft.GetUntracked(), "keep this draft\n> "+strings.TrimSuffix(copied, "\n")+"\n\n"; got != want {
			t.Errorf("native quote = %q, want %q", got, want)
		}
	})
}

func TestTranslationDialogOffersModelSettings(t *testing.T) {
	screen, a, _ := draftToolFixture(t)
	a.openTranslationWith("keep this original")
	screen.WaitFor("id:translate-dialog", time.Second)
	if a.activePane.GetUntracked() == "translation" {
		t.Fatal("translation replaced the conversation with a split pane")
	}
	screen.Find("id:translation-model-settings")
	d := a.translation.GetUntracked()
	screen.Press("id:translation-model-settings")
	if !a.settings.GetUntracked() || a.settingsTab.GetUntracked() != "models" {
		t.Fatal("model setup did not open Settings > Models")
	}
	screen.Settle()
	if len(screen.Query("id:translation-source")) != 0 {
		t.Fatal("translation dialog still covers model settings")
	}
	a.openTranslation()
	screen.WaitFor("id:translation-source", time.Second)
	if a.translation.GetUntracked() != d || d.source.GetUntracked() != "keep this original" {
		t.Fatal("model settings discarded the translation draft")
	}
	if strings.TrimSpace(screen.Find("id:translation-source").Text) != "keep this original" {
		t.Fatal("reopening did not restore the source")
	}
}
