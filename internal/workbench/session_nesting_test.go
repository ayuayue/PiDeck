//go:build !js && !android && !ios

package workbench

// Checks that a session pi spawned reads under the session that spawned it:
// the rail shows the parent with a disclosure, keeps the subagent folded
// until asked for, and finds it under the parent in a search.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

// nestSession writes one session file the way pi does, naming the session
// it spawned from when there is one.
func nestSession(t *testing.T, dir, id, cwd, prompt, parentFile string, at time.Time) string {
	t.Helper()
	ts := at.Format("2006-01-02T15:04:05.000Z")
	header := map[string]any{"type": "session", "version": 3, "id": id, "timestamp": ts, "cwd": filepath.ToSlash(cwd)}
	if parentFile != "" {
		header["parentSession"] = parentFile
	}
	message := map[string]any{"type": "message", "id": "m-" + id, "timestamp": ts,
		"message": map[string]any{"role": "user", "content": prompt, "timestamp": at.UnixMilli()}}
	head, err := json.Marshal(header)
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, at.Format("2006-01-02T15-04-05-000Z")+"_"+id+".jsonl")
	if err := os.WriteFile(path, append(append(head, '\n'), append(body, '\n')...), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// The listing reads the header's parentSession, so the rail knows which
// session spawned which without opening anything.
func TestSessionMetaReadsParentHeader(t *testing.T) {
	dir := t.TempDir()
	parent := nestSession(t, dir, "parent-1", "/work/nest", "父会话", "", time.Now())
	nestSession(t, dir, "child-1", "/work/nest", "子代理会话", parent, time.Now())

	byID := map[string]sessionMeta{}
	for _, name := range mustReadDir(t, dir) {
		read := readSessionMeta(filepath.Join(dir, name), metaCacheEntry{}, nil)
		if read.ok {
			byID[read.meta.ID] = read.meta
		}
	}
	if got := byID["parent-1"].Parent; got != "" {
		t.Fatalf("the parent lists a parent of its own: %q", got)
	}
	if got := byID["child-1"].Parent; got != parent {
		t.Fatalf("child parent = %q, want %q", got, parent)
	}
}

func mustReadDir(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

// The rail shows a spawned session under its parent: folded until the
// disclosure is opened, and found by a search under its parent even then.
func startNestFixture(t *testing.T) (*nsgotest.App, string) {
	t.Helper()
	home, workspace, piSessions := t.TempDir(), t.TempDir(), t.TempDir()
	dir := filepath.Join(piSessions, "--nest--")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	parentID, childID := "aaaaaaaa-1111-4222-8333-000000000001", "bbbbbbbb-1111-4222-8333-000000000002"
	parentFile := nestSession(t, dir, parentID, workspace, "父会话", "", now.Add(-2*time.Minute))
	nestSession(t, dir, childID, workspace, "子代理会话", parentFile, now.Add(-time.Minute))

	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PI_CODING_AGENT_SESSION_DIR", piSessions)
	raw, err := json.Marshal(config{Version: 1, Workspaces: []workspaceCfg{{Path: workspace, Name: "Nest", Expanded: true}},
		Theme: "system", SidebarOpen: true, ScanPi: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	app := nsgotest.Start(t, Root, nsgotest.Size(1320, 860))
	app.WaitFor("text:父会话", 20*time.Second)
	return app, "id:session-toggle-" + parentID
}

func TestRailNestsSpawnedSessions(t *testing.T) {
	app, toggle := startNestFixture(t)
	if !app.Exists(toggle) {
		t.Fatal("the rail shows no way to open the sessions below the parent")
	}
	if app.Exists("text:子代理会话") {
		t.Fatal("a spawned session shows before its parent is opened")
	}

	app.Press(toggle)
	app.WaitFor("text:子代理会话", 5*time.Second)
	// The child reads one step in from its parent: its row is narrower by the
	// indent, not laid out in the parent's column.
	rows := app.Query("id:session-row")
	if len(rows) != 2 || rows[0].Props.Label != "父会话" || rows[1].Props.Label != "子代理会话" {
		t.Fatalf("rows = %d, want the parent above its spawned session", len(rows))
	}
	if rows[1].Frame.Size.Width >= rows[0].Frame.Size.Width {
		t.Fatalf("the spawned session reads at its parent's indent: %v vs %v", rows[1].Frame, rows[0].Frame)
	}
	app.Press(toggle)
	app.WaitForGone("text:子代理会话", 5*time.Second)

	// A search keeps the match under the parent that spawned it, folded or
	// not: the row reads in context instead of nowhere. The palette is where
	// the query is typed now, and the rail filters behind it.
	app.Press("id:rail-search")
	app.WaitFor("id:session-search", 5*time.Second)
	app.Type("id:search-input", "子代理")
	app.WaitFor("text:子代理会话", 10*time.Second)
	if !app.Exists("text:父会话") {
		t.Fatal("a search showed the subagent without the session that spawned it")
	}
}
