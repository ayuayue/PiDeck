//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func installPrewarmACP(t *testing.T, a *app) {
	t.Helper()
	t.Setenv("PIDECK_FAKE_ACP", "1")
	t.Setenv("PIDECK_FAKE_ACP_UI", "1")
	raw, err := json.Marshal(map[string]any{"presets": []acpPreset{{
		ID: "prewarm", Name: "Prewarm fixture", Command: os.Args[0], Args: []string{"-test.run=^TestFakeACPAgent$"},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(a.st.dir, "acp")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "prewarm.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(closeAllACP)
}

func TestSessionPrewarmWaitsForTypingPauseAndReleasesClearedDraft(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	installPrewarmACP(t, a)
	onNativeUI(t, screen, a, func() {
		s.turns.Set(nil)
		s.draft.Set("")
		a.warmOK = true
		a.cfg.TrustedProjects = []string{trustKey(a.workspaceFor(s.Target, s.WS))}
		a.setBackend(s, "acp", "prewarm")
	})
	screen.Advance(time.Second)
	if s.hasAgent() || s.acpStarting != nil {
		t.Fatal("choosing a backend without a draft launched a process")
	}
	onNativeUI(t, screen, a, func() { s.draft.Set("first"); a.scheduleSessionPrewarm(s) })
	screen.Advance(sessionPrewarmDelay - time.Millisecond)
	if s.hasAgent() {
		t.Fatal("prewarm ran before the typing pause")
	}
	onNativeUI(t, screen, a, func() { s.draft.Set("first second"); a.scheduleSessionPrewarm(s) })
	screen.Advance(sessionPrewarmDelay - time.Millisecond)
	if s.hasAgent() {
		t.Fatal("another keystroke did not reset the debounce")
	}
	screen.Advance(time.Millisecond)
	screen.WaitUntil(10*time.Second, func() bool { return s.readySig.GetUntracked() && s.acp != nil })
	process := s.acp
	if !s.prewarming || a.warmPiInfo() != nil {
		t.Fatal("typing did not create a session-owned speculative process")
	}
	onNativeUI(t, screen, a, func() { s.draft.Set(""); a.scheduleSessionPrewarm(s) })
	screen.WaitUntil(5*time.Second, func() bool { return !s.agentStopping })
	select {
	case <-process.exited:
	default:
		t.Fatal("clearing the draft left its prewarmed process alive")
	}
	if s.hasAgent() || s.agentClosed || s.prewarming {
		t.Fatal("automatic retirement kept an agent or blocked later typing")
	}
}

func TestSessionPrewarmCancelsBeforeLaunch(t *testing.T) {
	for _, action := range []string{"clear", "switch", "close", "pane", "untrusted", "shell", "closed"} {
		t.Run(action, func(t *testing.T) {
			a, screen, s := startSessionLifecycleApp(t)
			onNativeUI(t, screen, a, func() {
				ws := a.workspaceFor(s.Target, s.WS)
				a.cfg.TrustedProjects = []string{trustKey(ws)}
				s.backend, s.acpPreset = "acp", "not-installed"
				s.draft.Set("a real question")
				a.scheduleSessionPrewarm(s)
				switch action {
				case "clear":
					s.draft.Set(" ")
					a.scheduleSessionPrewarm(s)
				case "switch":
					a.selectSession(a.blankSession("other", ws, "Other"))
				case "close":
					a.closeTab(s.ID)
				case "pane":
					a.openPane(paneSettings)
				case "untrusted":
					a.cfg.TrustedProjects = nil
				case "shell":
					s.draft.Set("!pwd")
					a.scheduleSessionPrewarm(s)
				case "closed":
					s.agentClosed = true
				}
			})
			screen.Advance(time.Second)
			if s.hasAgent() || s.acpStarting != nil || s.status.GetUntracked() != statusIdle {
				t.Fatal("cancelled or disallowed typing launched a backend")
			}
		})
	}
}

func TestSessionPrewarmExpiresOnlyWhileUnused(t *testing.T) {
	for _, action := range []string{"expire", "switch", "close", "explicit-start", "send"} {
		t.Run(action, func(t *testing.T) {
			a, screen, s := startSessionLifecycleApp(t)
			onNativeUI(t, screen, a, func() {
				a.cfg.TrustedProjects = []string{trustKey(a.workspaceFor(s.Target, s.WS))}
				s.engine = &piClient{in: nopWriteCloser{}}
				s.readySig.Set(true)
				s.prewarming = true
				a.expireSessionPrewarm(s)
				switch action {
				case "switch":
					a.selectSession(a.blankSession("other", a.workspaceFor(s.Target, s.WS), "Other"))
				case "close":
					a.closeTab(s.ID)
				case "explicit-start":
					a.ensureEngine(s, nil)
				case "send":
					// Hold the handshake so submit queues instead of writing RPC.
					s.starting = true
					a.submitTurn(s, "send immediately", nil, false)
				}
			})
			screen.Advance(sessionPrewarmTTL + time.Second)
			if action == "explicit-start" || action == "send" {
				if s.engine == nil || s.agentStopping || s.prewarming {
					t.Fatal("a claimed process was reclaimed by speculative expiry")
				}
				if action == "send" && len(s.waiters) != 1 {
					t.Fatal("sending during startup did not queue exactly once")
				}
				return
			}
			screen.WaitUntil(5*time.Second, func() bool { return !s.agentStopping })
			if s.engine != nil || s.prewarming || s.agentClosed || s.draft.GetUntracked() != "keep draft" {
				t.Fatal("retirement did not release only the unused process and retain its draft")
			}
		})
	}
}

func TestSessionPrewarmResumesTypingDuringRetirement(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	pending := make(chan *piClient)
	onNativeUI(t, screen, a, func() {
		a.cfg.TrustedProjects = []string{trustKey(a.workspaceFor(s.Target, s.WS))}
		a.env.Set(envInfo{Probed: true, PiError: "fixture does not launch pi"})
		s.starting = true
		s.piStarting = pending
		s.prewarming = true
		a.retireSessionPrewarm(s)
		s.draft.Set("typed while the old process stops")
		a.scheduleSessionPrewarm(s)
	})
	close(pending)
	screen.WaitUntil(5*time.Second, func() bool { return !s.agentStopping })
	screen.Advance(time.Second)
	if s.piGeneration.Load() != 1 || s.status.GetUntracked() != statusFailed ||
		!strings.Contains(s.notice.GetUntracked(), "fixture does not launch pi") {
		t.Fatal("typing while retirement was pending never attempted prewarm again")
	}
}

func TestComposerPrewarmStopsWhenOpeningPane(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("the fake ACP subprocess uses the headless test binary")
	}
	a, screen, s := chatDesignFixture(t, 0)
	installPrewarmACP(t, a)
	screen.Post(func() {
		s.turns.Set(nil)
		s.readySig.Set(false)
		a.cfg.TrustedProjects = []string{trustKey(a.workspaceFor(s.Target, s.WS))}
		a.setBackend(s, "acp", "prewarm")
	})
	screen.Type("id:composer", "a question not yet sent")
	screen.Advance(sessionPrewarmDelay)
	screen.WaitUntil(10*time.Second, func() bool { return s.readySig.GetUntracked() })
	process := s.acp
	screen.Post(func() { a.openPane(paneSettings) })
	screen.WaitUntil(5*time.Second, func() bool { return !s.agentStopping && !s.hasAgent() })
	select {
	case <-process.exited:
	default:
		t.Fatal("opening a pane kept an unused process alive")
	}
}

func TestColdComposerKeepsNativeInputAcrossStartup(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("checks the real native editor's insertion point")
	}
	a, screen, s := chatDesignFixture(t, 0)
	installPrewarmACP(t, a)
	screen.Post(func() {
		s.turns.Set(nil)
		s.readySig.Set(false)
		a.setBackend(s, "acp", "prewarm")
	})
	screen.WaitFor("id:empty-chat-logo", 5*time.Second)
	if screen.Exists("id:tab-status-"+s.ID) || strings.Contains(screen.Find("id:composer").Text, "启动") {
		t.Fatal("cold composer shows a process or startup placeholder")
	}
	shot(screen, "session-lazy/cold")
	screen.Type("id:composer", "keep typing")
	screen.Select("id:composer", 5, 5)
	before := screen.Find("id:composer")
	screen.Post(func() { s.starting = true; s.status.Set(statusStarting) })
	screen.WaitFor("id:tab-status-"+s.ID, 5*time.Second)
	after := screen.Find("id:composer")
	if after.ID != before.ID || !after.Focused || after.Text != before.Text {
		t.Fatal("startup changed the mounted native editor, focus or text")
	}
	shot(screen, "session-lazy/starting")
	screen.Post(func() { s.starting = false; s.readySig.Set(true); s.status.Set(statusIdle) })
	screen.Settle()
	screen.Type("id:composer", "继续")
	if got := screen.Find("id:composer"); got.ID != before.ID || got.Text != "keep 继续typing" || !got.Focused {
		t.Fatalf("ready editor lost its caret or text: %+v", got)
	}
	shot(screen, "session-lazy/ready")
}

func TestComposerKeepsInputAcrossStartupAndBackendSwitch(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("checks headless native input identity and composition")
	}
	a, screen, s := chatDesignFixture(t, 0)
	installPrewarmACP(t, a)
	onNativeUI(t, screen, a, func() {
		s.turns.Set(nil)
		s.readySig.Set(false)
		a.cfg.TrustedProjects = []string{trustKey(a.workspaceFor(s.Target, s.WS))}
		a.setBackend(s, "acp", "prewarm")
	})
	screen.WaitFor("id:empty-chat-logo", 5*time.Second)
	screen.Type("id:composer", "keep typing ")
	screen.Compose("id:composer", "你好")
	before := screen.Find("id:composer")
	screen.Advance(sessionPrewarmDelay)
	screen.WaitUntil(10*time.Second, func() bool { return s.readySig.GetUntracked() })
	after := screen.Find("id:composer")
	if after.ID != before.ID || !after.Focused || after.Text != before.Text || s.composing.GetUntracked() != "你好" {
		t.Fatal("startup remounted the editor or lost its draft, focus or IME composition")
	}
	process := s.acp
	onNativeUI(t, screen, a, func() {
		a.cfg.TrustedProjects = nil
		a.setBackend(s, "pi", "")
	})
	after = screen.Find("id:composer")
	if after.ID != before.ID || !after.Focused || s.composing.GetUntracked() != "你好" {
		t.Fatal("switching backends remounted the editor or reset composition")
	}
	screen.Commit("id:composer", "你好")
	if got := s.draft.GetUntracked(); got != "keep typing 你好" {
		t.Fatalf("committed draft = %q", got)
	}
	onNativeUI(t, screen, a, func() { a.retireSessionPrewarm(s) })
	screen.WaitUntil(5*time.Second, func() bool {
		select {
		case <-process.exited:
			return true
		default:
			return false
		}
	})
}
