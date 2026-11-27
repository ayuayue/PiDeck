//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

func draftToolFixture(t *testing.T) (*nsgotest.App, *app, *session) {
	t.Helper()
	if nsgotest.Target() != "" {
		t.Skip("headless regression; native fixture checks rendering")
	}
	fakeProviders(t)
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"scanPi":false,"telemetryEnabled":false,"autoModelCatalog":false}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var a *app
	var s *session
	// Scope cleanup flushes the debounced draft; join it before TempDir
	// removes the home rather than racing an atomic background rename.
	t.Cleanup(sessionDraftWrites.Wait)
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newApp(cx)
		a.cfg.ToolModels = map[string]toolModelCfg{
			"prompt": {Provider: "fake", Model: "smart"}, "predict": {Provider: "fake", Model: "fast"},
		}
		s = a.makeSession(sessionMeta{ID: "draft-tool", Title: "Draft fixture"}, localTarget)
		return core.View{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{FlexGrow: 1}},
			ui.Input{Value: s.draft.Get, OnChange: s.draft.Set, Label: "Draft", TestID: "draft-tool-input"},
			a.composerToolsMenu(s, s.toolsOpen),
			a.draftChangeBar(s), a.promptTemplateDialog(), a.translationDialog(),
		}}
	}, nsgotest.Size(1100, 760))
	t.Cleanup(a.closeDiag)
	return screen, a, s
}

func TestDraftToolsMenuAppliesModelResult(t *testing.T) {
	for _, tool := range []struct{ name, action, want string }{
		{"prompt", "prompt-enhance", "model result"},
		{"predict", "prompt-predict", "original draft model result"},
	} {
		t.Run(tool.name, func(t *testing.T) {
			screen, a, s := draftToolFixture(t)
			called := make(chan string, 1)
			a.llmFn = func(name, system, prompt string, max int) (string, error) {
				called <- name
				return "model result", nil
			}
			screen.Type("id:draft-tool-input", "original draft")
			screen.Press("id:composer-tools")
			screen.Press("id:" + tool.action)
			screen.WaitUntil(5*time.Second, func() bool { return s.draft.GetUntracked() == tool.want })
			select {
			case got := <-called:
				if got != tool.name {
					t.Fatalf("menu called %q, want %q", got, tool.name)
				}
			default:
				t.Fatal("menu did not invoke the tool model")
			}
			if s.toolsOpen.GetUntracked() {
				t.Fatal("tool menu remained open after selecting an action")
			}
		})
	}
}

func TestDraftToolsMenuAvailability(t *testing.T) {
	for _, state := range []struct{ name, draft, busy, hint string }{
		{"empty", " \n", "", "先输入草稿"},
		{"busy", "original draft", "prompt", "工具正在运行，请稍候"},
	} {
		t.Run(state.name, func(t *testing.T) {
			screen, a, s := draftToolFixture(t)
			s.draft.Set(state.draft)
			a.aiBusy.Set(state.busy)
			screen.Press("id:composer-tools")
			for _, id := range []string{"prompt-enhance", "prompt-predict"} {
				if screen.Enabled("id:" + id) {
					t.Fatalf("%s is enabled for %s", id, state.name)
				}
			}
			screen.WaitUntil(5*time.Second, func() bool { return len(screen.Query("text:"+state.hint)) == 2 })
			// Keep the popup open while its availability changes.
			s.draft.Set("original draft")
			a.aiBusy.Set("")
			screen.Settle()
			for _, id := range []string{"prompt-enhance", "prompt-predict"} {
				if !screen.Enabled("id:" + id) {
					t.Fatalf("%s did not become enabled", id)
				}
			}
		})
	}
}

func TestDraftToolsMenuMissingModelOpensSettings(t *testing.T) {
	for _, tool := range []struct{ name, action string }{
		{"prompt", "prompt-enhance"}, {"predict", "prompt-predict"},
	} {
		t.Run(tool.name, func(t *testing.T) {
			screen, a, s := draftToolFixture(t)
			screen.Press("id:composer-tools")
			// Model settings can change while the menu is already open.
			a.setToolModel(tool.name, "", "")
			screen.WaitFor("text:未配置模型，点击前往设置", time.Second)
			if !screen.Enabled("id:" + tool.action) {
				t.Fatal("missing model cannot be configured from an empty draft")
			}
			screen.Press("id:" + tool.action)
			if s.toolsOpen.GetUntracked() || a.activePaneID() != paneSettings || a.settingsTab.GetUntracked() != "models" {
				t.Fatal("missing model did not close the menu and open model settings")
			}
			if a.aiBusy.GetUntracked() != "" || s.draft.GetUntracked() != "" {
				t.Fatal("opening tool model settings changed the draft or started a model call")
			}
		})
	}
}

func TestDraftToolsPreserveEditsWhileWaiting(t *testing.T) {
	for _, tool := range []string{"prompt", "predict"} {
		for _, next := range []string{"new draft", ""} {
			t.Run(tool+"/"+next, func(t *testing.T) {
				screen, a, s := draftToolFixture(t)
				release := make(chan struct{})
				a.llmFn = func(string, string, string, int) (string, error) {
					<-release
					return "model result", nil
				}
				s.draft.Set("original draft")
				if tool == "prompt" {
					a.enhanceDraft(s)
				} else {
					a.predictDraft(s)
				}
				s.draft.Set(next)
				close(release)
				screen.WaitUntil(5*time.Second, func() bool { return a.aiBusy.GetUntracked() == "" })
				if got := s.draft.GetUntracked(); got != next {
					t.Fatalf("late %s result overwrote draft: got %q, want %q", tool, got, next)
				}
				change := s.draftChange.GetUntracked()
				if change == nil || change.Applied || change.After == "" {
					t.Fatalf("late result is not recoverable: %+v", change)
				}
				screen.Press("id:draft-change-apply")
				if got := s.draft.GetUntracked(); got != change.After {
					t.Fatalf("explicit apply = %q, want %q", got, change.After)
				}
				screen.Press("id:draft-change-undo")
				if got := s.draft.GetUntracked(); got != next {
					t.Fatalf("undo = %q, want latest draft %q", got, next)
				}
			})
		}
	}
}

func TestDraftChangeUndoDoesNotOverwriteNewEdits(t *testing.T) {
	screen, a, s := draftToolFixture(t)
	s.draft.Set("  original\n")
	a.offerDraftChange(s, "  original\n", "enhanced")
	screen.WaitFor("id:draft-change-undo", time.Second)
	s.draft.Set("kept editing")
	a.undoDraftChange(s)
	screen.WaitFor("id:draft-change-original", time.Second)
	if s.draft.GetUntracked() != "kept editing" {
		t.Fatal("undo overwrote a newer draft")
	}
	screen.Press("id:draft-change-dismiss")
	if s.draftChange.GetUntracked() != nil {
		t.Fatal("dismiss did not release the transient snapshot")
	}
}

func TestDraftToolEmptyOrDeletedResultDoesNotReplace(t *testing.T) {
	for _, deleted := range []bool{false, true} {
		t.Run(map[bool]string{false: "empty", true: "deleted"}[deleted], func(t *testing.T) {
			screen, a, s := draftToolFixture(t)
			a.llmFn = func(string, string, string, int) (string, error) {
				if deleted {
					return "late result", nil
				}
				return " \n", nil
			}
			s.draft.Set("original")
			a.enhanceDraft(s)
			s.deleting = deleted
			screen.WaitUntil(5*time.Second, func() bool { return a.aiBusy.GetUntracked() == "" })
			if s.draft.GetUntracked() != "original" || s.draftChange.GetUntracked() != nil {
				t.Fatal("empty/deleted result changed the composer")
			}
		})
	}
}

func TestRestoreQuestionPreservesOccupiedComposer(t *testing.T) {
	_, a, s := draftToolFixture(t)
	s.draft.Set("unsent work")
	a.restoreTurnDraft(s, turn{Prompt: "old question"})
	if s.draft.GetUntracked() != "unsent work" || s.draftChange.GetUntracked().After != "old question" {
		t.Fatal("restoring a question lost the unsent draft")
	}
	s.draftChange.Set(nil)
	s.draft.Set("")
	s.backend = "acp"
	a.editTurnPrompt(s, turn{Prompt: "ACP question"})
	if s.draft.GetUntracked() != "ACP question" || !s.draftChange.GetUntracked().Applied {
		t.Fatal("ACP edit did not prepare an undoable new message")
	}
}

func TestTranslationSourceDoesNotReplaceOpenWork(t *testing.T) {
	screen, a, _ := draftToolFixture(t)
	a.openTranslationWith("first reply")
	screen.WaitFor("id:translation-source", time.Second)
	d := a.translation.GetUntracked()
	d.output.Set("existing translation")
	a.openTranslationWith("another reply")
	if d.source.GetUntracked() != "first reply" || d.output.GetUntracked() != "existing translation" {
		t.Fatal("opening a reply replaced an existing translation")
	}
	a.closeTranslation()
	a.openTranslationWith("another reply")
	if a.translation.GetUntracked().source.GetUntracked() != "another reply" {
		t.Fatal("reply was not inserted into a fresh translation")
	}
}
