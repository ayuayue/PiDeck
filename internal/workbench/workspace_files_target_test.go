package workbench

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"strings"
	"testing"
	"time"
)

// This opt-in test uses an isolated project and a unique fixture under the
// target's app-owned sessions directory. It doesn't start an agent.
func TestWSLWorkspaceRoundTrip(t *testing.T) {
	distro := os.Getenv("PIDECK_LITE_TEST_WSL")
	if distro == "" {
		t.Skip("set PIDECK_LITE_TEST_WSL to exercise a WSL distribution")
	}
	target := target{Kind: targetWSL, Distro: distro}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	run := func(script string, args ...string) string {
		t.Helper()
		cmd, err := target.workspaceCommand(ctx, "/", script, args...)
		if err != nil {
			t.Fatal(err)
		}
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("WSL fixture: %v (%s)", err, out)
		}
		return strings.TrimSpace(string(out))
	}
	id := newSessionID()
	root := run(`set -eu; mktemp -d /tmp/pideck-lite-XXXXXX`)
	var trash string
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if !strings.HasPrefix(root, "/tmp/pideck-lite-") || path.Dir(root) != "/tmp" {
			return
		}
		cmd, err := target.workspaceCommand(ctx, "/", `
rm -f "$2/note.txt" "$HOME/.pideck-lite/sessions/$3.jsonl"
if [ -n "$4" ]; then rm -f "$HOME/.pideck-lite/trash/$4"; fi
rmdir "$2"`, root, id, trash)
		if err == nil {
			err = cmd.Run()
		}
		if err != nil {
			t.Error(err)
		}
	})
	file := run(`
set -eu
printf 'before\n' > "$2/note.txt"
dir="$HOME/.pideck-lite/sessions"
[ ! -L "$HOME/.pideck-lite" ] && [ ! -L "$dir" ]
mkdir -p "$dir"
file="$dir/$3.jsonl"
printf '%s\n' "$4" '{"type":"message","id":"entry","message":{"role":"user","content":"history"}}' > "$file"
printf '%s\n' "$file"
`, root, id, fmt.Sprintf(`{"type":"session","id":%q,"cwd":%q,"timestamp":"2026-01-01T00:00:00Z"}`, id, root))
	project := workspaceFile{target: target, root: root, rel: "note.txt"}
	before, err := project.read(ctx, 512)
	if err != nil || string(before) != "before\n" {
		t.Fatalf("remote read: %q, %v", before, err)
	}
	if _, err := project.save(ctx, workspaceRevision(before), []byte("after\n"), 512); err != nil {
		t.Fatal(err)
	}
	if _, err := project.save(ctx, workspaceRevision(before), []byte("stale\n"), 512); !errors.Is(err, errFileConflict) {
		t.Fatalf("stale revision: %v", err)
	}
	if after, err := project.read(ctx, 512); err != nil || string(after) != "after\n" {
		t.Fatalf("remote save: %q, %v", after, err)
	}
	metas, err := targetSessionMetas(ctx, target, root)
	if err != nil || len(metas) != 1 || metas[0].ID != id || metas[0].File != file {
		t.Fatalf("session headers: %v, %v", metas, err)
	}
	msgs, err := targetHistoryMessages(target, file)
	if err != nil || len(msgs) != 1 || msgs[0].EntryID != "entry" {
		t.Fatalf("remote transcript: %v, %v", msgs, err)
	}
	if _, err := target.trashSession(ctx, root+"/.pideck-lite/sessions/not-owned.jsonl"); !errors.Is(err, errFilePath) {
		t.Fatalf("deleting outside the app's remote store: %v", err)
	}
	trash, err = target.trashSession(ctx, file)
	if err != nil || trash == "" {
		t.Fatalf("move session to remote trash: %q, %v", trash, err)
	}
	if got := run(`set -eu; test ! -e "$2"; cat "$HOME/.pideck-lite/trash/$3"`, file, trash); !strings.Contains(got, `"content":"history"`) {
		t.Fatalf("remote trash contents: %q", got)
	}
}
