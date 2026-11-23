//go:build !js && !android && !ios

package workbench

// Checks a turn's deletion: pi's own context_edit records are appended,
// the file keeps its lines, and the transcript the app reads loses the turn.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const deleteSource = `{"type":"session","version":3,"id":"del","timestamp":"2026-06-01T10:00:00Z","cwd":"C:/work/shop"}
{"type":"message","id":"u1","message":{"role":"user","content":"第一个提问"}}
{"type":"message","id":"a1","message":{"role":"assistant","content":[{"type":"text","text":"第一个回答"}]}}
{"type":"message","id":"u2","message":{"role":"user","content":"第二个提问"}}
{"type":"message","id":"a2","message":{"role":"assistant","content":[{"type":"text","text":"第二个回答"}]}}
{"type":"message","id":"tr2","message":{"role":"toolResult","toolCallId":"c1","content":[{"type":"text","text":"工具输出"}]}}
{"type":"message","id":"u3","message":{"role":"user","content":"第三个提问"}}
{"type":"message","id":"a3","message":{"role":"assistant","content":[{"type":"text","text":"第三个回答"}]}}
`

// TestDeleteTurnAppendsContextEdits checks the records pi reads, chained on
// the file's leaf, and that the turn is what leaves the context.
func TestDeleteTurnAppendsContextEdits(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(st.dir, "del.jsonl")
	if err := os.WriteFile(src, []byte(deleteSource), 0o600); err != nil {
		t.Fatal(err)
	}
	ids, err := st.turnEntryIDs(src, "u2")
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"u2", "a2", "tr2"}; !equalStrings(ids, want) {
		t.Fatalf("turn entries = %v, want %v", ids, want)
	}
	if err := st.appendContextEdits(src, ids); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	// The file still holds every word: the deletion is an append.
	for _, kept := range []string{"第二个提问", "第二个回答", "工具输出"} {
		if !strings.Contains(string(raw), kept) {
			t.Errorf("the file lost %q", kept)
		}
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 11 {
		t.Fatalf("file has %d lines, want 11", len(lines))
	}
	parent := "a3" // the leaf the records hang from
	for i, want := range []string{"u2", "a2", "tr2"} {
		var record struct {
			Type     string `json:"type"`
			ID       string `json:"id"`
			ParentID string `json:"parentId"`
			Target   string `json:"targetId"`
			Replace  any    `json:"replacement"`
		}
		if err := json.Unmarshal([]byte(lines[8+i]), &record); err != nil {
			t.Fatal(err)
		}
		if record.Type != contextEditType || record.Target != want || record.Replace != nil {
			t.Errorf("record %d = %+v, want a delete of %q", i, record, want)
		}
		if record.ParentID != parent {
			t.Errorf("record %d hangs off %q, want %q", i, record.ParentID, parent)
		}
		parent = record.ID
	}

	msgs, err := sessionFileMessages(src)
	if err != nil {
		t.Fatal(err)
	}
	var shown []string
	for _, msg := range msgs {
		shown = append(shown, msg.text())
	}
	joined := strings.Join(shown, "|")
	if strings.Contains(joined, "第二个提问") || strings.Contains(joined, "第二个回答") || strings.Contains(joined, "工具输出") {
		t.Errorf("the deleted turn is still shown: %s", joined)
	}
	for _, want := range []string{"第一个提问", "第一个回答", "第三个提问", "第三个回答"} {
		if !strings.Contains(joined, want) {
			t.Errorf("the transcript lost %q: %s", want, joined)
		}
	}
}

// TestTurnEntryIDsRefusesUnknown checks an id from another file deletes
// nothing.
func TestTurnEntryIDsRefusesUnknown(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(st.dir, "del.jsonl")
	if err := os.WriteFile(src, []byte(deleteSource), 0o600); err != nil {
		t.Fatal(err)
	}
	if ids, err := st.turnEntryIDs(src, "nope"); err == nil || len(ids) != 0 {
		t.Fatalf("turnEntryIDs(unknown) = %v, %v; want a refusal", ids, err)
	}
}

func equalStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
