//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/ui/chat"
)

// A streamed answer must repaint in place: rebuilding the prose on every
// delta threw the view's identity away, which flickered the paragraph and
// dropped anything the user had selected in it.
func TestStreamedTextKeepsItsMount(t *testing.T) {
	built, screen, sess := startNativeSurfaceApp(t)
	emit := func(record string) {
		t.Helper()
		var ev piEvent
		if err := json.Unmarshal([]byte(record), &ev); err != nil {
			t.Fatal(err)
		}
		built.onPiEvent(sess, ev)
		screen.Settle()
	}
	onNativeUI(t, screen, built, func() {
		sess.turns.Set(nil)
		sess.loaded.Set(true)
		sess.readySig.Set(true)
		sess.draft.Set("")
		sess.turns.Update(func(turns []turn) []turn {
			return append(turns, turn{ID: "fixture-mount", Prompt: "写一段话", Status: chat.Running, Start: built.cx.Now()})
		})
		sess.runningSig.Set(true)
	})
	emit(`{"type":"agent_start"}`)
	emit(`{"type":"message_start","message":{"role":"assistant"}}`)
	emit(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"第一段"}}`)
	screen.Advance(80 * time.Millisecond)
	first := screen.WaitFor("text:第一段", 5*time.Second)

	emit(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"，第二段"}}`)
	screen.Advance(80 * time.Millisecond)
	second := screen.WaitFor("text:第一段，第二段", 5*time.Second)
	if first.ID != second.ID {
		t.Fatalf("the streaming prose was rebuilt: view %d became %d", first.ID, second.ID)
	}

	// A committing message must not rebuild the step that follows it: the
	// prose stays where it is, as a step of a finished message.
	emit(`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"第一段，第二段"},{"type":"toolCall","id":"tool-mount","name":"read","arguments":{"path":"readme.md"}}]}}`)
	emit(`{"type":"tool_execution_start","toolName":"read","toolCallId":"tool-mount","args":{"path":"readme.md"}}`)
	emit(`{"type":"tool_execution_end","toolName":"read","toolCallId":"tool-mount","durationMs":12,"result":{"content":[{"type":"text","text":"ok"}]}}`)
	emit(`{"type":"message_start","message":{"role":"assistant"}}`)
	emit(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"再补一句"}}`)
	screen.Advance(80 * time.Millisecond)
	committed := screen.WaitFor("text:第一段，第二段", 5*time.Second)
	if committed.ID != second.ID {
		t.Fatalf("a committed message rebuilt the prose: view %d became %d", second.ID, committed.ID)
	}

	// The next message's deltas paint their own step, not this one.
	emit(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"，还有一句"}}`)
	screen.Advance(80 * time.Millisecond)
	screen.WaitFor("text:再补一句，还有一句", 5*time.Second)
	again := screen.WaitFor("text:第一段，第二段", 5*time.Second)
	if again.ID != committed.ID {
		t.Fatalf("the next message rebuilt an older step: view %d became %d", committed.ID, again.ID)
	}
}
