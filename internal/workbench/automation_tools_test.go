//go:build !js && !android && !ios

package workbench

// The app-owned tools nsgo mcp serves, called the way an agent reaches them:
// from the app's own graph, through automation.Call. A UI test that needs a
// state rather than the presses that reach it can do the same.

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/automation"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// callAutomationTool runs one of the app's tools on its graph and decodes the
// answer into out.
func callAutomationTool(t *testing.T, screen *nsgotest.App, a *app, name string, args any, out any) error {
	t.Helper()
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	var answer json.RawMessage
	var callErr error
	screen.Post(func() {
		answer, callErr = automation.Call(a.cx, context.Background(), name, raw)
	})
	screen.Settle()
	if callErr != nil {
		if errors.Is(callErr, errors.ErrUnsupported) {
			t.Skip("automation tools need the nsgotest build: run go tool nsgo test")
		}
		return callErr
	}
	if out != nil && len(answer) > 0 {
		if err := json.Unmarshal(answer, out); err != nil {
			t.Fatalf("%s answered %s: %v", name, answer, err)
		}
	}
	return nil
}

// TestAutomationStateReportsTheWorkbench covers the tool an agent reads first:
// it names the open session and the page showing, with the counts around them.
func TestAutomationStateReportsTheWorkbench(t *testing.T) {
	built, screen, sess := startNativeSurfaceApp(t)
	var state automationState
	if err := callAutomationTool(t, screen, built, "pideck_state", map[string]any{}, &state); err != nil {
		t.Fatal(err)
	}
	if state.Session != sess.ID || state.Title != sess.title.GetUntracked() {
		t.Fatalf("state = %+v, want session %q", state, sess.ID)
	}
	if state.Page != "" {
		t.Fatalf("page = %q, want no page while a session shows", state.Page)
	}
	if state.Sessions != 1 || state.Turns != 1 {
		t.Fatalf("counts = %d sessions, %d turns, want 1 and 1", state.Sessions, state.Turns)
	}
}

// TestAutomationOpensAPageAndSeedsTurns is the pair an agent or a test uses
// instead of pressing through the rail and asking pi for a transcript.
func TestAutomationOpensAPageAndSeedsTurns(t *testing.T) {
	built, screen, _ := startNativeSurfaceApp(t)
	var state automationState
	if err := callAutomationTool(t, screen, built, "pideck_seed_turns", map[string]any{
		"turns": []map[string]string{{"prompt": "种下的提问", "answer": "种下的回答"}},
	}, &state); err != nil {
		t.Fatal(err)
	}
	if state.Turns != 2 {
		t.Fatalf("turns = %d after seeding one, want 2", state.Turns)
	}
	screen.WaitFor("text:种下的回答", 5*time.Second)

	if err := callAutomationTool(t, screen, built, "pideck_open_page", map[string]any{"page": paneSettings}, &state); err != nil {
		t.Fatal(err)
	}
	if state.Page != paneSettings {
		t.Fatalf("page = %q, want %q", state.Page, paneSettings)
	}
	screen.WaitFor("id:pane-column", 5*time.Second)

	// A page the app does not have is refused instead of opening nothing.
	if err := callAutomationTool(t, screen, built, "pideck_open_page", map[string]any{"page": "nonesuch"}, nil); err == nil {
		t.Fatal("opening an unknown page should fail")
	}
}
