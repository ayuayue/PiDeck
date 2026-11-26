//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

const selectionParagraph = "Translate only this paragraph. Keep the introduction unchanged."

func chatSelectionFixture(t *testing.T) (*nsgotest.App, *app, *session, *session) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	t.Setenv("PIDECK_V2_LANG", "zh-CN")
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"scanPi":false,"telemetryEnabled":false,"autoModelCatalog":false,"theme":"light"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var a *app
	var first, second *session
	t.Cleanup(sessionDraftWrites.Wait)
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newApp(cx)
		first = a.makeSession(sessionMeta{ID: "selection-first", Title: "阅读与翻译"}, localTarget)
		second = a.makeSession(sessionMeta{ID: "selection-second", Title: "另一个会话"}, localTarget)
		first.turns.Set([]turn{{ID: "first-turn", Prompt: "请解释这两段文字。", Status: chat.Completed,
			Final: "This introduction stays in the conversation.\n\n" + selectionParagraph}})
		second.turns.Set([]turn{{ID: "second-turn", Prompt: "另一个问题", Final: "Another conversation.", Status: chat.Completed}})
		first.loaded.Set(true)
		second.loaded.Set(true)
		a.activeID.Set(first.ID)
		if nsgotest.Target() != "" {
			a.tabs.Set([]string{first.ID, second.ID})
			return a.view()
		}
		// A sidebar and header expose mistakes between selection-local and
		// surface coordinates without starting any agent process.
		return core.View{Style: ui.FillRest.Merge(core.Style{Direction: core.Row}), Children: []core.Node{
			core.View{Style: core.Style{Width: core.Pt(180)}, Children: []core.Node{
				ui.Button{Text: "Switch", TestID: "fixture-switch", OnPress: func() { a.activeID.Set(second.ID) }},
				ui.Button{Text: "Outside", TestID: "fixture-outside", OnPress: func() {}},
			}},
			core.View{Style: ui.FillRest, Children: []core.Node{
				core.View{Style: core.Style{Height: core.Pt(52)}}, a.chatPane(),
			}},
			a.translationDialog(),
		}}
	}, nsgotest.Size(1280, 860), nsgotest.Environment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop}))
	t.Cleanup(a.closeDiag)
	screen.WaitFor("text:"+selectionParagraph, 5*time.Second)
	return screen, a, first, second
}

func selectChatParagraph(t *testing.T, screen *nsgotest.App) core.Bounds {
	t.Helper()
	area := screen.Find("id:transcript-column").Bounds()
	text := screen.Find("text:" + selectionParagraph).Bounds()
	box := core.Bounds{Origin: core.Point{X: text.Origin.X - area.Origin.X, Y: text.Origin.Y - area.Origin.Y}, Size: text.Size}
	screen.SelectText("id:transcript-column", box)
	screen.WaitFor("id:chat-selection-translate", 5*time.Second)
	return core.Bounds{Origin: core.Point{X: area.Origin.X + box.Origin.X, Y: area.Origin.Y + box.Origin.Y}, Size: box.Size}
}

func TestChatSelectionOpensOnlySelectedText(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless selection contract; native test drives the mouse")
	}
	screen, a, _, _ := chatSelectionFixture(t)
	var calls atomic.Int32
	a.llmFn = func(string, string, string, int) (string, error) { calls.Add(1); return "translated", nil }
	screen.Clipboard = "clipboard stays private"
	columnID := screen.Find("id:transcript-column").ID
	textID := screen.Find("text:" + selectionParagraph).ID
	box := selectChatParagraph(t, screen)
	button := screen.Find("id:chat-selection-translate").Bounds()
	if button.Origin.X < box.Origin.X || button.Origin.Y < box.Origin.Y+box.Size.Height || button.Origin.Y > box.Origin.Y+box.Size.Height+16 {
		t.Fatalf("translation action %v is not beside the selection endpoint %v", button, box)
	}
	if got := screen.Find("id:transcript-column").ID; got != columnID {
		t.Fatalf("selection rebuilt transcript: got node %v, want %v", got, columnID)
	}
	if got := screen.Find("text:" + selectionParagraph).ID; got != textID {
		t.Fatalf("selection rebuilt reply: got node %v, want %v", got, textID)
	}
	if a.translation.GetUntracked() != nil || calls.Load() != 0 {
		t.Fatal("selecting text opened a translation or called a model")
	}
	screen.Press("id:chat-selection-translate")
	screen.WaitFor("id:translation-source", 5*time.Second)
	if got := screen.Find("id:translation-source").Text; got != selectionParagraph {
		t.Fatalf("translation source = %q, want only %q", got, selectionParagraph)
	}
	if calls.Load() != 0 || screen.Clipboard != "clipboard stays private" {
		t.Fatal("opening selected text called the model or changed the clipboard")
	}
	d := a.translation.GetUntracked()
	d.output.Set("existing translation")
	a.openTranslationWith("a different reply")
	if a.translation.GetUntracked() != d || d.source.GetUntracked() != selectionParagraph || d.output.GetUntracked() != "existing translation" {
		t.Fatal("another entry replaced the translation opened from the selection")
	}
	a.closeTranslation()
	screen.Settle()
	if len(screen.Query("id:chat-selection-translate")) != 0 {
		t.Fatal("closing translation restored a stale selection action")
	}
}

func TestChatSelectionDismissesWithItsContext(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless selection contract; native test drives the mouse")
	}
	for _, action := range []string{"clear", "escape", "outside", "resize", "session", "scroll"} {
		t.Run(action, func(t *testing.T) {
			screen, a, first, _ := chatSelectionFixture(t)
			if action == "scroll" {
				first.turns.Update(func(turns []turn) []turn {
					return append([]turn{{ID: "long-turn", Prompt: "Long history", Final: strings.Repeat("Earlier history.\n\n", 70), Status: chat.Completed}}, turns...)
				})
				screen.Settle()
			}
			selectChatParagraph(t, screen)
			switch action {
			case "clear":
				screen.Press("id:fixture-outside")
			case "escape":
				// NSGo's test host hands Escape to the focused text view first,
				// which drops the host's own selection without reaching the
				// overlay's OnCancel. Release that selection first, as the user's
				// own pointer does on hardware, then press Escape.
				screen.SelectText("id:transcript-column", core.Bounds{})
				screen.Key("Escape")
			case "outside":
				screen.Press("id:fixture-outside")
			case "resize":
				screen.Resize(980, 720)
			case "session":
				screen.Press("id:fixture-switch")
				// Returning to the first session must not resurrect its old
				// selection, even though the session itself is still open.
				a.activeID.Set(first.ID)
			case "scroll":
				screen.Scroll("id:chat-transcript", -120)
			}
			screen.Settle()
			if len(screen.Query("id:chat-selection-translate")) != 0 {
				t.Fatalf("%s left a stale selection action", action)
			}
			if a.translation.GetUntracked() != nil {
				t.Fatalf("%s started a translation", action)
			}
		})
	}
}

// A native mouse-down clears the text selection before releasing the
// action. Drive that order explicitly; a plain headless Press omits it.
func TestChatSelectionSurvivesNativePressClearing(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless event ordering regression; native test drives the mouse")
	}
	for _, finish := range []string{"press", "leave", "escape"} {
		t.Run(finish, func(t *testing.T) {
			screen, a, _, _ := chatSelectionFixture(t)
			selectChatParagraph(t, screen)
			screen.Hover("id:chat-selection-translate")
			screen.SelectText("id:transcript-column", core.Bounds{})
			screen.WaitFor("id:chat-selection-translate", 5*time.Second)
			switch finish {
			case "press":
				screen.Press("id:chat-selection-translate")
				screen.WaitFor("id:translation-source", 5*time.Second)
				if got := screen.Find("id:translation-source").Text; got != selectionParagraph {
					t.Fatalf("native clearing lost the selected text: got %q, want %q", got, selectionParagraph)
				}
			case "leave":
				screen.HoverOut()
			case "escape":
				screen.Key("Escape")
			}
			screen.Settle()
			if len(screen.Query("id:chat-selection-translate")) != 0 {
				t.Fatalf("%s left the action after the native selection cleared", finish)
			}
			if finish != "press" && a.translation.GetUntracked() != nil {
				t.Fatalf("%s unexpectedly opened a translation", finish)
			}
		})
	}
}

func TestNativeChatSelectionTranslation(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native mouse selection and screenshot fixture")
	}
	screen, a, _, _ := chatSelectionFixture(t)
	screen.DragAt("text:"+selectionParagraph, core.Point{X: 2, Y: 12}, core.Point{X: 130})
	screen.WaitFor("id:chat-selection-translate", 5*time.Second)
	screen.Hover("id:chat-selection-translate")
	shot(screen, "selection/partial-light")
	screen.Press("id:chat-selection-translate")
	screen.WaitFor("id:translation-source", 5*time.Second)
	source := screen.Find("id:translation-source").Text
	if strings.TrimSpace(source) == "" || source == selectionParagraph || !strings.Contains(selectionParagraph, source) {
		t.Fatalf("native selection opened %q, want a nonempty part of %q", source, selectionParagraph)
	}
	shot(screen, "selection/translation-source")
	onNativeUI(t, screen, a, func() { a.closeTranslation(); a.theme.Set("dark"); a.applyTheme() })
	screen.DragAt("text:"+selectionParagraph, core.Point{X: 2, Y: 12}, core.Point{X: 130})
	screen.WaitFor("id:chat-selection-translate", 5*time.Second)
	shot(screen, "selection/partial-dark")
	screen.Resize(760, 700)
	screen.WaitFor("id:chat-selection-translate", 5*time.Second)
	screen.Press("id:chat-selection-translate")
	screen.WaitFor("id:translation-source", 5*time.Second)
	if got := screen.Find("id:translation-source").Text; got != source {
		t.Fatalf("resizing changed the existing selection: got %q, want %q", got, source)
	}
	onNativeUI(t, screen, a, func() { a.closeTranslation() })
	screen.DragAt("text:"+selectionParagraph, core.Point{X: 2, Y: 12}, core.Point{X: 100, Y: 28})
	screen.WaitFor("id:chat-selection-translate", 5*time.Second)
	shot(screen, "selection/multiline-narrow")
}
