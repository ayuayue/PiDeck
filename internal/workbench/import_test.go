//go:build !js && !android && !ios

package workbench

// Checks for importing other agents' sessions: what each source's file
// becomes in pi's terms, and that a second import of the same session is a
// no-op while a changed one is read again.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"example.com/pideck-lite/internal/sessionimport"
)

// importFixture writes a source file and imports it, returning the listing.
func importFixture(t *testing.T, source *sessionimport.Source, dir, name, body string, cwd string) sessionMeta {
	t.Helper()
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	parsed, err := source.Read(path)
	if err != nil {
		t.Fatalf("reading %s: %v", name, err)
	}
	meta, err := st.writeFileImport(*source, path, parsed, cwd)
	if err != nil {
		t.Fatalf("importing %s: %v", name, err)
	}
	return meta
}

// importText joins an imported file's message texts, for a rough check.
func importText(t *testing.T, file string) string {
	t.Helper()
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// TestImportStateTracksTheSource checks the marker: a fresh import is
// current, a changed source is outdated, and a missing file is new.
func TestImportStateTracksTheSource(t *testing.T) {
	dir := t.TempDir()
	body := `{"type":"user","sessionId":"c3","cwd":"C:/work/z","timestamp":"2026-06-01T10:00:00Z","message":{"role":"user","content":"一"}}` + "\n"
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "c3.jsonl")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	cand := sessionimport.Candidate{Source: "claude", ID: "c3", Path: path, Size: info.Size(), MTime: info.ModTime()}
	parsed, err := sessionimport.Claude.Read(path)
	if err != nil {
		t.Fatal(err)
	}
	meta, err := st.writeFileImport(*sessionimport.Claude, path, parsed, "C:/work/z")
	if err != nil {
		t.Fatal(err)
	}
	target := meta.File
	if state := sessionimport.StateOf(target, cand, sessionimport.Claude.Version); state != sessionimport.Current {
		t.Fatalf("state after import = %v, want current", state)
	}
	cand.Size++
	if state := sessionimport.StateOf(target, cand, sessionimport.Claude.Version); state != sessionimport.Outdated {
		t.Fatalf("state after a source change = %v, want outdated", state)
	}
	if state := sessionimport.StateOf(filepath.Join(dir, "nope.jsonl"), cand, sessionimport.Claude.Version); state != sessionimport.New {
		t.Fatalf("state of a new session = %v, want new", state)
	}
	// A second import of the same file keeps the session's identity.
	again, err := st.writeFileImport(*sessionimport.Claude, path, parsed, "C:/work/z")
	if err != nil {
		t.Fatal(err)
	}
	if again.ID != meta.ID {
		t.Fatalf("re-import made a new session: %s then %s", meta.ID, again.ID)
	}
}

// TestImportZCode reads a session out of a small ZCode database.
func TestImportZCode(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	dbPath := sessionimport.ZCodeDB(root)
	createSQLite(t, dbPath,
		`create table session (id text, directory text, title text, time_created integer, time_updated integer)`,
		`create table message (id text, session_id text, sequence integer, time_created integer, time_updated integer, data text)`,
		`create table part (id text, message_id text, session_id text, sequence integer, time_created integer, time_updated integer, data text)`,
		`insert into session values ('sess_1','C:/work/z','看构建',1,2)`,
		`insert into message values ('m1','sess_1',1,10,10,'{"role":"user","time_created":10}')`,
		`insert into message values ('m2','sess_1',2,20,20,'{"role":"assistant","providerID":"zai","modelID":"glm","finish":"stop","time_created":20}')`,
		`insert into part values ('p1','m1','sess_1',1,10,10,'{"type":"text","text":"看看构建"}')`,
		`insert into part values ('p2','m2','sess_1',2,20,20,'{"type":"tool","callID":"call-9","tool":"bash","state":{"status":"completed","input":{"cmd":"go build"},"output":"ok"}}')`,
		`insert into part values ('p3','m2','sess_1',3,20,20,'{"type":"text","text":"构建通过"}')`,
	)
	cands, err := sessionimport.ScanZCode(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(cands) != 1 || cands[0].Cwd != "C:/work/z" || cands[0].Title != "看构建" {
		t.Fatalf("candidates = %+v", cands)
	}
	parsed, err := sessionimport.ZCode.Read(cands[0].Path)
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Messages) != 3 {
		t.Fatalf("messages = %d, want user, assistant and result: %+v", len(parsed.Messages), parsed.Messages)
	}
	if parsed.Messages[2].Role != "toolResult" || parsed.Messages[2].Text != "ok" {
		t.Fatalf("tool result = %+v", parsed.Messages[2])
	}
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	meta, err := st.writeFileImport(*sessionimport.ZCode, cands[0].Path, parsed, "C:/work/z")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(meta.Title, "ZCode · ") {
		t.Fatalf("title = %q", meta.Title)
	}
}

// TestImportedSessionReadsBack checks the written file is a pi session this
// app lists and can read: header, messages, no tool left unanswered.
func TestImportedSessionReadsBack(t *testing.T) {
	dir := t.TempDir()
	body := strings.Join([]string{
		`{"type":"user","sessionId":"c9","cwd":"C:/work/r","timestamp":"2026-06-01T10:00:00Z","message":{"role":"user","content":"跑测试"}}`,
		`{"type":"assistant","sessionId":"c9","cwd":"C:/work/r","timestamp":"2026-06-01T10:00:01Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"bash","input":{"cmd":"go test"}}]}}`,
	}, "\n") + "\n"
	meta := importFixture(t, sessionimport.Claude, dir, "c9.jsonl", body, "")
	if meta.Count < 3 {
		t.Fatalf("listing counts %d messages, want the call's empty answer too", meta.Count)
	}
	msgs, err := sessionFileMessages(meta.File)
	if err != nil {
		t.Fatal(err)
	}
	turns := turnsFromMessages(msgs)
	if len(turns) != 1 || turns[0].Prompt != "跑测试" {
		t.Fatalf("turns = %+v", turns)
	}
	if len(turns[0].Steps) != 1 || len(turns[0].Steps[0].Tools) != 1 {
		t.Fatalf("the tool call did not read back: %+v", turns[0].Steps)
	}
	raw, _ := os.ReadFile(meta.File)
	var head map[string]any
	if err := json.Unmarshal([]byte(strings.SplitN(string(raw), "\n", 2)[0]), &head); err != nil {
		t.Fatal(err)
	}
	if head["type"] != "session" || head["cwd"] != filepath.Clean("C:/work/r") {
		t.Fatalf("header = %+v", head)
	}
	if !strings.Contains(string(raw), `"type":"claude_import"`) {
		t.Fatal("the file has no import marker")
	}
	_ = time.Now
}
