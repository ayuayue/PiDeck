//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestCloseAgentSettlesTurnAndKeepsSession(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	onNativeUI(t, screen, a, func() {
		s.engine = &piClient{in: nopWriteCloser{}}
		s.readySig.Set(true)
		s.turns.Set([]turn{{ID: "in-flight", Prompt: "keep prompt", Status: chat.Running}})
		s.runningSig.Set(true)
		s.sending.Set([]queuedMessage{{Text: "do not send"}})
		a.closeAgent(s)
	})
	screen.WaitUntil(5*time.Second, func() bool { return s.engine == nil && !s.readySig.GetUntracked() })
	if s.busyNow() || s.turns.GetUntracked()[0].Status != chat.Cancelled {
		t.Fatalf("closed agent left a running turn: busy=%v, turns=%+v", s.busyNow(), s.turns.GetUntracked())
	}
	if a.byID[s.ID] != s || len(a.tabs.GetUntracked()) != 1 || s.draft.GetUntracked() == "" {
		t.Fatal("closing the agent discarded the session, tab or draft")
	}
	if len(s.sending.GetUntracked()) != 0 {
		t.Fatal("closing the agent kept queued follow-ups")
	}
	// Selecting a deliberately closed session must remain a read-only action.
	onNativeUI(t, screen, a, func() { a.selectSession(s) })
	if s.starting || s.engine != nil {
		t.Fatal("selecting the closed tab restarted its agent")
	}
}

func TestCloseAgentDiscardsOldPiCallbacks(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	onNativeUI(t, screen, a, func() {
		generation := s.piGeneration.Load()
		s.engine = &piClient{in: nopWriteCloser{}}
		s.readySig.Set(true)
		// Queue a callback before close, and deliver another after close.
		a.onPiEventGeneration(s, generation, piEvent{Type: "agent_start"})
		a.onPiUIGeneration(s, generation, uiRequest{Method: "set_editor_text", Text: "stale draft"})
		a.closeAgent(s)
		a.onPiEventGeneration(s, generation, piEvent{Type: "agent_start"})
	})
	screen.WaitUntil(5*time.Second, func() bool { return !s.agentStopping })
	if s.status.GetUntracked() != statusIdle || s.draft.GetUntracked() == "stale draft" {
		t.Fatal("old pi callbacks changed the closed session")
	}
}

func TestACPLifecycleRestartsAndClosesProcess(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	t.Setenv("PIDECK_FAKE_ACP", "1")
	t.Setenv("PIDECK_FAKE_ACP_RESUME", "1")
	preset, err := json.Marshal(map[string]any{"presets": []acpPreset{{ID: "lifecycle", Name: "Lifecycle fixture", Command: os.Args[0], Args: []string{"-test.run=^TestFakeACPAgent$"}}}})
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(a.st.dir, "acp")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "lifecycle.json"), preset, 0o600); err != nil {
		t.Fatal(err)
	}
	onNativeUI(t, screen, a, func() {
		s.backend, s.acpPreset = "acp", "lifecycle"
		a.ensureEngine(s, nil)
	})
	screen.WaitUntil(10*time.Second, func() bool { return s.acp != nil && s.readySig.GetUntracked() })
	first, sid, generation := s.acp, s.acpSID, s.acpGeneration
	onNativeUI(t, screen, a, func() { a.restartAgent(s) })
	screen.WaitUntil(10*time.Second, func() bool { return s.acp != nil && s.acp != first && s.readySig.GetUntracked() })
	select {
	case <-first.exited:
	default:
		t.Fatal("restart left the old ACP process running")
	}
	if s.acpSID != sid || s.acpMode.GetUntracked() != "resumed" {
		t.Fatal("restart did not resume the original ACP session")
	}
	second := s.acp
	onNativeUI(t, screen, a, func() {
		// An exit from the prior process cannot disconnect the new one.
		a.onACPExit(s, generation, nil)
		if s.acp != second {
			t.Fatal("a stale ACP exit detached the new process")
		}
		a.closeAgent(s)
	})
	screen.WaitUntil(10*time.Second, func() bool { return !s.agentStopping })
	select {
	case <-second.exited:
	default:
		t.Fatal("close left the ACP process running")
	}
	onNativeUI(t, screen, a, func() { a.selectSession(s) })
	if s.acp != nil || s.starting || s.acpSID != sid {
		t.Fatal("closed ACP session restarted or lost its resume ID")
	}
}

func TestReloadSessionPreservesDraftAndReportsReadFailure(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	file := filepath.Join(t.TempDir(), "history.jsonl")
	if err := os.WriteFile(file, []byte(piSessionFile(s.ID, s.WS)), 0o600); err != nil {
		t.Fatal(err)
	}
	draft := s.draft.GetUntracked()
	onNativeUI(t, screen, a, func() { s.File = file; a.reloadSession(s) })
	screen.WaitUntil(5*time.Second, func() bool { return !s.historyLoading })
	if turns := s.turns.GetUntracked(); len(turns) != 1 || turns[0].Prompt != s.ID {
		t.Fatalf("reloaded turns = %+v", turns)
	}
	if s.draft.GetUntracked() != draft || s.engine != nil {
		t.Fatal("reload changed the draft or started an agent")
	}
	onNativeUI(t, screen, a, func() { s.File = file + "-missing"; a.reloadSession(s) })
	screen.WaitUntil(5*time.Second, func() bool { return !s.historyLoading })
	screen.WaitFor("text:重新读取会话失败", 5*time.Second)
	if s.turns.GetUntracked()[0].Prompt != s.ID {
		t.Fatal("failed reload discarded the visible transcript")
	}
}

func TestCloseAgentCancelsStartupWaiters(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	launched := make(chan *piClient, 1)
	c := &piClient{in: nopWriteCloser{}}
	onNativeUI(t, screen, a, func() {
		s.starting = true
		s.piStarting = launched
		s.status.Set(statusStarting)
		s.waiters = []func(){func() { t.Error("closed agent sent its pending prompt") }}
		a.closeAgent(s)
	})
	launched <- c
	screen.WaitUntil(5*time.Second, func() bool { return !s.agentStopping })
	if !c.isClosed() {
		t.Fatal("a process launched after close was left running")
	}
	if len(s.waiters) != 0 || s.readySig.GetUntracked() {
		t.Fatal("closing during startup retained readiness or pending actions")
	}
}

func TestCloseAgentWinsOverPendingRestart(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	launched := make(chan *piClient, 1)
	onNativeUI(t, screen, a, func() {
		s.starting = true
		s.piStarting = launched
		a.restartAgent(s)
		a.closeAgent(s)
	})
	launched <- &piClient{in: nopWriteCloser{}}
	screen.WaitUntil(5*time.Second, func() bool { return !s.agentStopping })
	if s.starting || s.engine != nil || !s.agentClosed {
		t.Fatal("a pending restart overrode close")
	}
}

func TestACPArchiveReloadWaitsForLatestSnapshot(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	onNativeUI(t, screen, a, func() {
		s.backend = "acp"
		a.saveACPArchive(s)
		s.turns.Update(func(ts []turn) []turn { ts[0].Final = "latest answer"; return ts })
		a.saveACPArchive(s)
		a.reloadSession(s)
	})
	screen.WaitUntil(5*time.Second, func() bool { return !s.historyLoading })
	if got := s.turns.GetUntracked()[0].Final; got != "latest answer" {
		t.Fatalf("reloaded answer = %q, want latest snapshot", got)
	}
}

func TestSessionLifecycleCommandsRejectUnavailableActions(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	onNativeUI(t, screen, a, func() {
		for _, command := range builtinCommands() {
			switch command.ID {
			case "start-agent", "restart-agent":
				if !command.When(a) {
					t.Errorf("%s unavailable for an idle session", command.ID)
				}
			case "close-agent", "reload-session":
				if command.When(a) {
					t.Errorf("%s offered without a process or saved file", command.ID)
				}
			}
		}
		s.agentStopping = true
		s.status.Set(statusWaiting)
		for _, command := range builtinCommands() {
			switch command.ID {
			case "start-agent", "restart-agent", "close-agent", "reload-session":
				if command.When(a) {
					t.Errorf("%s available while stopping", command.ID)
				}
			}
		}
		s.agentStopping = false
		s.status.Set(statusIdle)
	})
}

func TestSessionRunActionsAreDiscoverable(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	screen.WaitFor("id:session-agent-toggle", 5*time.Second)
	screen.Press("id:session-actions")
	screen.WaitFor("text:启动 Agent", 5*time.Second)
	screen.WaitFor("text:重新读取会话", 5*time.Second)
	if nsgotest.Target() != "" {
		screen.Screenshot("session-controls-menu")
	}
	onNativeUI(t, screen, a, func() {
		if a.byID[s.ID] != s {
			t.Fatal("opening the actions menu changed the session")
		}
	})
}

func TestCloseAgentConfirmationCanBeCancelled(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	c := &piClient{in: nopWriteCloser{}}
	onNativeUI(t, screen, a, func() {
		s.engine = c
		s.readySig.Set(true)
		s.runningSig.Set(true)
		s.turns.Set([]turn{{ID: "running", Status: chat.Running}})
		a.askCloseAgent(s)
	})
	screen.WaitFor("id:confirm", 5*time.Second)
	screen.Press("id:confirm-cancel")
	screen.WaitForGone("id:confirm", 5*time.Second)
	if s.engine != c || !s.busyNow() || c.isClosed() {
		t.Fatal("cancelling the confirmation stopped the agent")
	}
	onNativeUI(t, screen, a, func() { a.askCloseAgent(s) })
	screen.WaitFor("id:confirm-ok", 5*time.Second)
	screen.Press("id:confirm-ok")
	screen.WaitUntil(5*time.Second, func() bool { return !s.agentStopping && s.engine == nil })
}

func TestTabRunMenuTargetsItsOwnSession(t *testing.T) {
	a, screen, active := startSessionLifecycleApp(t)
	var background *session
	onNativeUI(t, screen, a, func() {
		background = a.blankSession("background", a.activeWorkspace(), "后台会话")
		background.engine = &piClient{in: nopWriteCloser{}}
		background.readySig.Set(true)
		a.addTab(background.ID)
	})
	screen.WaitUntil(5*time.Second, func() bool { return len(screen.Query("id:tab")) == 2 })
	screen.RightClick("id:tab >> nth=1")
	screen.WaitFor("text:关闭 Agent", 5*time.Second)
	screen.Press("text:关闭 Agent")
	screen.WaitUntil(5*time.Second, func() bool { return background.engine == nil && !background.agentStopping })
	if a.activeID.GetUntracked() != active.ID || active.agentClosed {
		t.Fatal("the background tab menu operated on the active session")
	}
}

func TestSessionToolbarStaysVisibleWhenTabsOverflow(t *testing.T) {
	a, screen, s := startSessionLifecycleApp(t)
	onNativeUI(t, screen, a, func() {
		for i := range 15 {
			other := a.blankSession(fmt.Sprintf("tab-%d", i), a.activeWorkspace(), "很长的会话标题")
			a.addTab(other.ID)
		}
	})
	screen.Resize(760, 600)
	screen.WaitFor("id:session-agent-toggle", 5*time.Second)
	buttons := screen.Query("id:session-actions")
	if len(buttons) != 1 || buttons[0].Frame.Origin.X < 0 || buttons[0].Frame.Origin.X+buttons[0].Frame.Size.Width > 760 {
		t.Fatalf("actions overflowed the window: %+v", buttons)
	}
	if a.activeID.GetUntracked() != s.ID {
		t.Fatal("adding tabs changed the active session")
	}
}

// Mount the real session controls independently of unrelated composer features.
func startSessionLifecycleApp(t *testing.T) (*app, *nsgotest.App, *session) {
	t.Helper()
	home, project := t.TempDir(), t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	t.Setenv("PIDECK_V2_LANG", "zh-CN")
	raw, err := json.Marshal(config{Version: 1, Theme: "light", ScanPi: false})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	var a *app
	var s *session
	t.Cleanup(closeAllPi)
	t.Cleanup(closeAllACP)
	t.Cleanup(acpArchiveWrites.Wait)
	t.Cleanup(sessionDraftWrites.Wait)
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newApp(cx)
		ws := &workspace{Path: project, Target: localTarget, Expanded: core.NewSignal(cx, true),
			Sessions: core.NewSignalFunc(cx, []*session(nil), nil), Pi: core.NewSignalFunc(cx, []*session(nil), nil),
			PiOpen: core.NewSignal(cx, false), PiLoading: core.NewSignal(cx, false), Visible: core.NewSignal(cx, 0)}
		a.workspaces.Set([]*workspace{ws})
		s = a.blankSession("lifecycle-session", ws, "生命周期测试")
		s.turns.Set([]turn{{ID: "saved", Prompt: "saved prompt", Final: "saved answer", Status: chat.Completed}})
		s.draft.Set("keep draft")
		ws.Sessions.Set([]*session{s})
		a.activeID.Set(s.ID)
		a.activeWS.Set(project)
		a.tabs.Set([]string{s.ID})
		return core.View{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Height: core.Pt(40), Direction: core.Row}, Children: []core.Node{a.tabBar()}},
			a.confirmDialog(), ui.Toasts{Toaster: a.toaster},
		}}
	}, nsgotest.Size(1100, 700))
	t.Cleanup(a.closeDiag)
	return a, screen, s
}
