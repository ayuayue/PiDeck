//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"testing"
)

// A message reads in the order pi wrote it: the prose goes before its calls
// when it came first, and after them when it came last. Before this, every
// call was drawn above the prose whatever the transcript said.
func TestStepKeepsProseOrder(t *testing.T) {
	message := func(content string) piMessage {
		var msg piMessage
		if err := json.Unmarshal([]byte(`{"role":"assistant","content":`+content+`}`), &msg); err != nil {
			t.Fatal(err)
		}
		return msg
	}
	cases := []struct {
		name    string
		content string
		want    int
		wantTxt string
	}{
		{"prose then two calls", `[{"type":"text","text":"先说明"},
			{"type":"toolCall","id":"a","name":"read","arguments":{"path":"a.md"}},
			{"type":"toolCall","id":"b","name":"read","arguments":{"path":"b.md"}}]`, 0, "先说明"},
		{"two calls then prose", `[{"type":"toolCall","id":"a","name":"read","arguments":{"path":"a.md"}},
			{"type":"toolCall","id":"b","name":"read","arguments":{"path":"b.md"}},
			{"type":"text","text":"再说明"}]`, 2, "再说明"},
		{"call between the prose", `[{"type":"toolCall","id":"a","name":"read","arguments":{"path":"a.md"}},
			{"type":"text","text":"中间说明"},
			{"type":"toolCall","id":"b","name":"read","arguments":{"path":"b.md"}}]`, 1, "中间说明"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			turns := turnsFromMessages([]piMessage{
				{Role: "user", Content: json.RawMessage(`"做点事"`)},
				message(c.content),
			})
			if len(turns) != 1 || len(turns[0].Steps) != 1 {
				t.Fatalf("turns = %+v, want one turn with one step", turns)
			}
			step := turns[0].Steps[0]
			if step.Text != c.wantTxt {
				t.Fatalf("step prose = %q, want %q", step.Text, c.wantTxt)
			}
			if step.TextAt != c.want {
				t.Fatalf("step prose sits after %d calls, want %d", step.TextAt, c.want)
			}
			if len(step.Tools) != 2 {
				t.Fatalf("step tools = %d, want 2", len(step.Tools))
			}
		})
	}
}

// The live path folds the same order: a message that commits with prose
// before its calls keeps the prose above them.
func TestCommittedMessageKeepsProseOrder(t *testing.T) {
	built, screen, sess := startNativeSurfaceApp(t)
	onNativeUI(t, screen, built, func() {
		sess.turns.Set([]turn{{ID: "order-1", Prompt: "做点事"}})
	})
	var ev piEvent
	raw := `{"type":"message_end","message":{"role":"assistant","content":[` +
		`{"type":"toolCall","id":"call-1","name":"read","arguments":{"path":"a.md"}},` +
		`{"type":"text","text":"读完了"}]}}`
	if err := json.Unmarshal([]byte(raw), &ev); err != nil {
		t.Fatal(err)
	}
	built.onPiEvent(sess, ev)
	screen.Settle()
	step := sess.turns.GetUntracked()[0].Steps[0]
	if step.TextAt != 1 {
		t.Fatalf("the committed prose sits after %d calls, want 1", step.TextAt)
	}
}
