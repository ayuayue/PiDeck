//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestNotePreviewPreservesShortTextAndUnicode(t *testing.T) {
	for _, tc := range []struct {
		name, text, want string
		folded           bool
	}{
		{name: "empty"},
		{name: "short", text: "任务目标与验证结论。", want: "任务目标与验证结论。"},
		{name: "exact character limit", text: strings.Repeat("文", 600), want: strings.Repeat("文", 600)},
		{name: "unicode", text: strings.Repeat("文", 599) + "🙂尾", want: strings.Repeat("文", 599) + "🙂…", folded: true},
		{name: "six lines", text: "一\n二\n三\n四\n五\n六", want: "一\n二\n三\n四\n五\n六"},
		{name: "many lines", text: "一\n二\n三\n四\n五\n六\n七", want: "一\n二\n三\n四\n五\n六…", folded: true},
		{name: "windows lines", text: "一\r\n二\r\n三\r\n四\r\n五\r\n六\r\n七", want: "一\r\n二\r\n三\r\n四\r\n五\r\n六…", folded: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, folded := notePreview(tc.text)
			if got != tc.want || folded != tc.folded || !utf8.ValidString(got) {
				t.Errorf("notePreview = (%q, %v), want (%q, %v) with valid UTF-8", got, folded, tc.want, tc.folded)
			}
		})
	}
}

func TestCompactionSummaryFoldsAndRemembersChoice(t *testing.T) {
	a, screen, s := startNativeSurfaceApp(t)
	screen.SetEnvironment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop})
	summary := strings.Repeat("保留任务目标、实现约束和验证结论。\n", 8) + "\n摘要末尾标记"
	result, err := json.Marshal(map[string]string{"summary": summary})
	if err != nil {
		t.Fatal(err)
	}
	onNativeUI(t, screen, a, func() {
		s.turns.Set(nil)
		s.loaded.Set(true)
		s.draft.Set("")
		a.applyEvent(s, piEvent{Type: "compaction_start"})
	})
	screen.WaitFor("id:note-card >> text:正在压缩上下文…", 5*time.Second)
	var stepID string
	onNativeUI(t, screen, a, func() {
		a.applyEvent(s, piEvent{Type: "compaction_end", Result: result})
		stepID = s.turns.GetUntracked()[0].Steps[0].ID
	})
	screen.WaitFor("id:note-card >> text:上下文已压缩", 5*time.Second)
	if len(screen.Query("text:摘要末尾标记")) != 0 {
		t.Fatal("long compaction summary showed its tail before being expanded")
	}
	toggle := "id:note-toggle-" + stepID
	screen.WaitFor(toggle, 5*time.Second)
	shot(screen, "compaction/collapsed")
	screen.Press(toggle)
	screen.WaitFor("text:摘要末尾标记", 5*time.Second)
	shot(screen, "compaction/expanded")

	// A rebuild and another completed compaction must retain the first
	// card's choice without opening the new card.
	onNativeUI(t, screen, a, func() {
		a.addNote(s, "compaction", "上下文已压缩", strings.Repeat("第二次压缩保留后续工作。\n", 8)+"第二份摘要末尾", chat.Completed)
	})
	screen.WaitFor("text:第二次压缩保留后续工作。", 5*time.Second)
	screen.WaitFor("text:摘要末尾标记", 5*time.Second)
	if len(screen.Query("text:第二份摘要末尾")) != 0 {
		t.Fatal("a new compaction inherited the previous card's expanded state")
	}
	screen.Press(toggle)
	screen.WaitForGone("text:摘要末尾标记", 5*time.Second)
	// The disclosure is a normal keyboard-accessible button too.
	screen.Focus(toggle)
	screen.Key("enter")
	screen.WaitFor("text:摘要末尾标记", 5*time.Second)
	onNativeUI(t, screen, a, func() {
		if got := s.turns.GetUntracked()[0].Steps[0].Text; got != summary {
			t.Errorf("folding changed the stored summary: got %q, want %q", got, summary)
		}
	})
}

func TestCompactionShortSummaryIsNotFolded(t *testing.T) {
	a, screen, s := startNativeSurfaceApp(t)
	var stepID string
	onNativeUI(t, screen, a, func() {
		s.turns.Set(nil)
		s.loaded.Set(true)
		s.draft.Set("")
		a.addNote(s, "compact", "上下文已压缩", "保留了任务目标与验证结论。", chat.Completed)
		stepID = s.turns.GetUntracked()[0].Steps[0].ID
	})
	screen.WaitFor("text:保留了任务目标与验证结论。", 5*time.Second)
	if len(screen.Query("id:note-toggle-"+stepID)) != 0 {
		t.Fatal("a short compaction summary has an unnecessary fold control")
	}
}
