//go:build !js && !android && !ios

package workbench

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestOpeningHistoryDoesNotStartAgent(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	file := historyFile(t, "只读历史")
	onNativeUI(t, screen, a, func() {
		s.turns.Set(nil)
		s.loaded.Set(false)
		s.File = file
		a.selectSession(s)
		if s.starting || s.engine != nil || s.acp != nil {
			t.Error("opening history launched an agent")
		}
	})
	screen.WaitUntil(5*time.Second, func() bool { return s.loaded.GetUntracked() })
	if turns := s.turns.GetUntracked(); len(turns) != 1 || turns[0].Prompt != "只读历史" {
		t.Fatalf("cold history = %+v", turns)
	}
}

func TestBrowsingSlowHistoryDoesNotPrewarmRestoredDraft(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	file := historyFile(t, "slow history")
	onNativeUI(t, screen, a, func() {
		a.cfg.TrustedProjects = []string{trustKey(a.workspaceFor(s.Target, s.WS))}
		a.env.Set(envInfo{Probed: true, PiError: "fixture does not launch pi"})
		s.turns.Set(nil)
		s.loaded.Set(false)
		s.File = file
		a.selectSession(s)
		a.selectSession(a.blankSession("other", a.workspaceFor(s.Target, s.WS), "Other"))
		a.selectSession(s)
	})
	screen.WaitUntil(5*time.Second, func() bool { return s.loaded.GetUntracked() })
	screen.Advance(time.Second)
	if s.piGeneration.Load() != 0 || s.hasAgent() || s.status.GetUntracked() != statusIdle {
		t.Fatal("browsing slow history treated a restored draft as new input")
	}
}

func TestTypingWhileHistoryLoadsPrewarmsAfterRead(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	file := historyFile(t, "slow history")
	onNativeUI(t, screen, a, func() {
		a.cfg.TrustedProjects = []string{trustKey(a.workspaceFor(s.Target, s.WS))}
		a.env.Set(envInfo{Probed: true, PiError: "fixture does not launch pi"})
		s.turns.Set(nil)
		s.loaded.Set(false)
		s.File = file
		a.loadHistoryFromFile(s)
		s.draft.Set("new input while history loads")
		a.scheduleSessionPrewarm(s)
	})
	screen.WaitUntil(5*time.Second, func() bool { return s.loaded.GetUntracked() })
	screen.Advance(time.Second)
	if s.status.GetUntracked() != statusFailed || !strings.Contains(s.notice.GetUntracked(), "fixture does not launch pi") {
		t.Fatal("history completion did not attempt the requested prewarm")
	}
}

func TestOpeningACPHistoryDoesNotStartAgent(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	onNativeUI(t, screen, a, func() {
		s.backend, s.acpPreset = "acp", "missing-preset"
		a.selectSession(s)
		if s.starting || s.acpStarting != nil {
			t.Error("opening an ACP archive launched an agent")
		}
	})
}

func TestColdComposerDoesNotClaimStartup(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	onNativeUI(t, screen, a, func() {
		for _, backend := range []string{"pi", "acp"} {
			s.backend = backend
			if got := a.composerPlaceholder(s)(); strings.Contains(got, "启动") {
				t.Errorf("cold %s placeholder claims startup: %s", backend, got)
			}
		}
	})
}

func TestColdHistoryKeepsPendingPrompt(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	onNativeUI(t, screen, a, func() {
		s.turns.Set(append(s.turns.GetUntracked(), turn{ID: "pending", Prompt: "new question", Status: chat.Running}))
		s.starting = true
		called := 0
		s.waiters = []func(){func() { called++ }}
		a.historyReady(s)
		if called != 0 {
			t.Fatal("cold file read released a prompt without a ready process")
		}
		s.readySig.Set(true)
		a.historyFromPi(s, []turn{{ID: "compact", Prompt: "compacted context", Status: chat.Completed}}, nil)
		turns := s.turns.GetUntracked()
		if called != 1 || len(turns) != 2 || turns[1].ID != "pending" || !turns[1].running() {
			t.Fatalf("history replacement lost the queued prompt: called=%d turns=%+v", called, turns)
		}
	})
}

func TestACPExitDoesNotRestartWhileBrowsing(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	onNativeUI(t, screen, a, func() {
		s.backend = "acp"
		s.acp = &acpClient{}
		s.readySig.Set(true)
		a.onACPExit(s, s.acpGeneration, errors.New("fixture exit"))
		if s.starting || s.acpStarting != nil || s.acp != nil || s.readySig.GetUntracked() {
			t.Fatal("ACP exit restarted an idle session")
		}
	})
}

func TestColdHistoryMissingFileSettles(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	onNativeUI(t, screen, a, func() {
		s.turns.Set(nil)
		s.loaded.Set(false)
		s.File = filepath.Join(t.TempDir(), "missing.jsonl")
		a.loadHistoryFromFile(s)
	})
	screen.WaitUntil(5*time.Second, func() bool { return s.loaded.GetUntracked() })
	if s.engine != nil || s.starting {
		t.Fatal("a failed history read started a process")
	}
}
