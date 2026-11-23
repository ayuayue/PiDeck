//go:build !js && !android && !ios

package workbench

// Checks the retry's transition: the fork is in the rail at once with its
// "重试中" spinner, the session it came from leaves the rail, and the copied
// file then carries the turn's prompt into the new session.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/ui/chat"
)

// TestRetryShowsTheForkAtOnce drives a failed turn through retry and checks
// what the window holds before and after the copy lands.
func TestRetryShowsTheForkAtOnce(t *testing.T) {
	// An empty PATH keeps pi from starting: the retry's bookkeeping is what
	// this checks, not the agent.
	t.Setenv("PATH", t.TempDir())
	built, screen, sess := startNativeSurfaceApp(t)
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	head, err := json.Marshal(map[string]any{"type": "session", "version": 3, "id": "retry-src",
		"timestamp": "2026-06-01T10:00:00Z", "cwd": sess.WS})
	if err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(dir, "retry-src.jsonl")
	body := string(head) + "\n" +
		`{"type":"message","id":"u1","message":{"role":"user","content":"跑一遍测试"}}` + "\n" +
		`{"type":"message","id":"a1","message":{"role":"assistant","content":[{"type":"text","text":"测试挂了"}]}}` + "\n"
	if err := os.WriteFile(src, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	now := built.cx.Now()
	onNativeUI(t, screen, built, func() {
		built.st = st
		built.cfg = st.config()
		// The retry sends its prompt at once, so the project has to be one
		// the user already allowed agents in.
		if ws := built.workspaceFor(sess.Target, sess.WS); ws != nil {
			key := trustKey(ws)
			built.cfg.TrustedProjects = append(built.cfg.TrustedProjects, key)
			st.edit(func(c *config) { c.TrustedProjects = append(c.TrustedProjects, key) })
		}
		sess.File = src
		sess.loaded.Set(true)
		sess.readySig.Set(true)
		sess.turns.Set([]turn{{ID: "h0", Prompt: "跑一遍测试", Status: chat.Failed, Err: "boom",
			Start: now.Add(-time.Minute), End: now.Add(-time.Minute)}})
	})
	screen.WaitFor("text:boom", 5*time.Second)
	onNativeUI(t, screen, built, func() {
		built.retry(sess, sess.turns.GetUntracked()[0])
	})

	// The fork is opened at once, spinning, while the old session leaves the
	// rail and the tabs.
	fork := built.active()
	if fork == nil || fork == sess {
		t.Fatal("the retry did not open a fork")
	}
	if !strings.Contains(fork.title.GetUntracked(), "重试") {
		t.Fatalf("fork title = %q, want a retry name", fork.title.GetUntracked())
	}
	if !fork.retryPendingNow() {
		t.Log("note: the copy was done before it could be seen retrying")
	}
	if !built.sessionArchived(sess.ID) {
		t.Error("the session that failed is still in the rail")
	}
	for _, id := range built.tabs.GetUntracked() {
		if id == sess.ID {
			t.Error("the failed session keeps its tab")
		}
	}

	// The copied file carries the prompt, which is sent again.
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		screen.Settle()
		turns := fork.turns.GetUntracked()
		done := false
		for _, x := range turns {
			if x.Prompt == "跑一遍测试" && !x.running() {
				done = true
			}
		}
		if done {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	turns := fork.turns.GetUntracked()
	if len(turns) == 0 || turns[0].Prompt != "跑一遍测试" {
		t.Fatalf("fork file=%q turns=%+v", fork.File, turns)
	}
	if fork.File == "" {
		t.Fatal("the fork never got its file")
	}
	if fork.retryPendingNow() {
		t.Error("the fork still says it is retrying once the file is there")
	}
}

// TestRetryingShowsItsSpinner checks what a fork says while its copy runs:
// the transcript's placeholder, and the composer that waits with it.
func TestRetryingShowsItsSpinner(t *testing.T) {
	built, screen, sess := startNativeSurfaceApp(t)
	onNativeUI(t, screen, built, func() {
		sess.turns.Set([]turn{{ID: "pending", Status: chat.Waiting, Start: built.cx.Now(), Noticed: "重试中"}})
		sess.retrying.Set(true)
	})
	screen.WaitFor("text:重试中 · 0s", 5*time.Second)
	if got := len(screen.Query("id:composer")); got != 1 {
		t.Fatalf("the composer is not on screen: %d", got)
	}
	onNativeUI(t, screen, built, func() {
		if !built.composerBlocked(sess) {
			t.Error("a session being forked accepts a message")
		}
	})
}
