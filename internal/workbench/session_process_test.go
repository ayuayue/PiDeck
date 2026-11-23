//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/ui/chat"
)

// One run of work is one group: the thinking and the calls of several
// messages belong together as long as the turn said nothing in between, so
// a long turn reads as a few summaries instead of one per message.
func TestProcessNodesGroupsOneRun(t *testing.T) {
	blocks := func(steps ...string) []processItem {
		var items []processItem
		for _, step := range steps {
			items = append(items, blockItem(step, 0))
		}
		return items
	}
	say := func(step string) processItem { return sayItem(step) }

	cases := []struct {
		name  string
		items []processItem
		// want is the rows a turn shows: "g" for a group, "say" for what it
		// said, "note" for a system note.
		want []string
	}{
		{"three messages, nothing said", blocks("a", "b", "c"), []string{"g"}},
		{"a message said something", []processItem{blockItem("a", 0), say("a"), blockItem("b", 0)}, []string{"g", "say", "g"}},
		{"prose with no call after it", []processItem{blockItem("a", 0), say("a")}, []string{"g", "say"}},
		{"two messages said nothing, then prose", []processItem{blockItem("a", 0), blockItem("b", 0), say("b"), blockItem("b", 1)}, []string{"g", "say", "g"}},
		{"a note ends the run", []processItem{blockItem("a", 0), {id: "s", step: "s", kind: processNote}}, []string{"g", "note"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			nodes := processNodes(c.items)
			got := make([]string, 0, len(nodes))
			for _, n := range nodes {
				switch n.kind {
				case processGroup:
					got = append(got, "g")
				case processProse:
					got = append(got, "say")
				case processNote:
					got = append(got, "note")
				}
			}
			if len(got) != len(c.want) {
				t.Fatalf("rows = %v, want %v", got, c.want)
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Fatalf("rows = %v, want %v", got, c.want)
				}
			}
			// A group keeps its members in the order pi wrote them.
			for _, n := range nodes {
				if n.kind != processGroup {
					continue
				}
				if len(n.members) == 0 {
					t.Fatal("a group holds no rows")
				}
				if n.id != "g:"+n.members[0].id {
					t.Fatalf("group id = %q, want it keyed by its first row", n.id)
				}
			}
		})
	}
}

// The screen shows one group per run of work: three messages that only
// thought and called tools, with nothing said in between, head one
// summary — not one per message.
func TestTurnProcessGroupsOneRunOnScreen(t *testing.T) {
	built, screen, sess := startNativeSurfaceApp(t)
	now := time.Now()
	step := func(id string, tools int) turnStep {
		runs := make([]toolRun, 0, tools)
		for range tools {
			runs = append(runs, toolRun{CallID: id + "-call", Name: "read", Action: "读取",
				Detail: "readme.md", Status: chat.Completed, DurationMs: 8})
		}
		return turnStep{ID: id, Thinking: "先看看文件。", Tools: runs, Start: now}
	}
	onNativeUI(t, screen, built, func() {
		sess.loaded.Set(true)
		sess.readySig.Set(true)
		sess.turns.Set([]turn{{ID: "run-1", Prompt: "读几个文件", Status: chat.Completed, Model: "fixture/model",
			Start: now.Add(-40 * time.Second), End: now.Add(-10 * time.Second),
			Steps: []turnStep{step("run-1-s0", 2), step("run-1-s1", 2), step("run-1-s2", 2)}, Tools: 6, Final: "读完了"}})
	})
	screen.WaitFor("text:读完了", 5*time.Second)
	screen.Press("text:6 个工具调用")
	screen.WaitFor("text:执行过程 · 6 个工具调用 · 思考", 5*time.Second)
	if got := len(screen.Query("text:执行过程 · 6 个工具调用 · 思考")); got != 1 {
		t.Fatalf("the run heads %d groups, want 1", got)
	}
	if got := len(screen.Query("text:执行过程 · 2 个工具调用 · 思考")); got != 0 {
		t.Fatalf("a message head a group of its own: %d", got)
	}
	screen.Press("text:执行过程 · 6 个工具调用 · 思考")
	screen.WaitUntil(5*time.Second, func() bool { return len(screen.Query("label:读取 readme.md")) == 6 })
}

// What the turn said in between still splits its process: the prose stands
// between the group before it and the calls that followed.
func TestTurnProcessSplitsAtProse(t *testing.T) {
	built, screen, sess := startNativeSurfaceApp(t)
	now := time.Now()
	onNativeUI(t, screen, built, func() {
		sess.loaded.Set(true)
		sess.readySig.Set(true)
		sess.turns.Set([]turn{{ID: "split-1", Prompt: "做点事", Status: chat.Completed, Model: "fixture/model",
			Start: now.Add(-40 * time.Second), End: now.Add(-10 * time.Second), Tools: 2, Final: "做完了",
			Steps: []turnStep{
				{ID: "split-1-s0", Thinking: "先看看文件。", Start: now,
					Tools: []toolRun{{CallID: "split-1-a", Name: "read", Action: "读取", Detail: "readme.md", Status: chat.Completed}}},
				{ID: "split-1-s1", Text: "我看看另一个文件", Start: now,
					Tools: []toolRun{{CallID: "split-1-b", Name: "read", Action: "读取", Detail: "go.mod", Status: chat.Completed}}},
			}}})
	})
	screen.WaitFor("text:做完了", 5*time.Second)
	screen.Press("text:2 个工具调用")
	screen.WaitFor("text:执行过程 · 1 个工具调用 · 思考", 5*time.Second)
	screen.WaitFor("text:我看看另一个文件", 5*time.Second)
	if got := len(screen.Query(`text:"执行过程 · 1 个工具调用"`)); got != 1 {
		t.Fatalf("the calls after the prose head %d groups, want 1", got)
	}
}

// A turn that is still working keeps its newest group open: only a turn
// that ended, or one that said something in between, folds its own work.
func TestRunningTurnKeepsItsGroupOpen(t *testing.T) {
	built, screen, sess := startNativeSurfaceApp(t)
	now := time.Now()
	run := turn{ID: "live-1", Prompt: "读文件", Status: chat.Running, Model: "fixture/model", Start: now, Tools: 2,
		Steps: []turnStep{{ID: "live-1-s0", Thinking: "先看看文件。", Text: "看过一部分", Start: now,
			Tools: []toolRun{{CallID: "live-1-a", Name: "read", Action: "读取", Detail: "readme.md", Status: chat.Completed}}}}}
	onNativeUI(t, screen, built, func() {
		sess.loaded.Set(true)
		sess.readySig.Set(true)
		sess.turns.Set([]turn{run})
		sess.runningSig.Set(true)
	})
	// The turn is running, so its newest group — the calls after the prose it
	// said — opens by itself; the group it moved past stays closed.
	screen.WaitFor("text:执行过程 · 1 个工具调用", 5*time.Second)
	screen.WaitFor("label:读取 readme.md", 5*time.Second)
	if got := len(screen.Query("text:执行过程 · 思考")); got != 1 {
		t.Fatalf("the group it moved past is not headed: %d", got)
	}

	// Once it ends with an answer, the group it was working in folds too.
	onNativeUI(t, screen, built, func() {
		settled := run
		settled.Status = chat.Completed
		settled.Final = "读完了"
		settled.End = now.Add(time.Second)
		sess.turns.Set([]turn{settled})
		sess.runningSig.Set(false)
	})
	screen.WaitForGone("label:读取 readme.md", 5*time.Second)
	screen.WaitFor("text:读完了", 5*time.Second)
}

// An open group reads in a window of its own: many calls do not push the
// answer below them out of the turn.
func TestProcessGroupBodyIsBounded(t *testing.T) {
	built, screen, sess := startNativeSurfaceApp(t)
	now := time.Now()
	runs := make([]toolRun, 0, 40)
	for i := range 40 {
		runs = append(runs, toolRun{CallID: fmt.Sprintf("many-%d", i), Name: "read", Action: "读取",
			Detail: fmt.Sprintf("file-%d.md", i), Status: chat.Completed})
	}
	onNativeUI(t, screen, built, func() {
		sess.loaded.Set(true)
		sess.readySig.Set(true)
		sess.turns.Set([]turn{{ID: "many-1", Prompt: "读很多文件", Status: chat.Completed, Model: "fixture/model",
			Start: now.Add(-time.Minute), End: now, Tools: len(runs), Final: "都读完了",
			Steps: []turnStep{{ID: "many-1-s0", Thinking: "一次读完。", Tools: runs, Start: now}}}})
	})
	screen.WaitFor("text:都读完了", 5*time.Second)
	screen.Press("text:40 个工具调用")
	screen.WaitFor("text:执行过程 · 40 个工具调用 · 思考", 5*time.Second)
	screen.Press("text:执行过程 · 40 个工具调用 · 思考")
	screen.WaitFor("label:读取 file-39.md", 5*time.Second)
	// The rows live in a scroll view the window bounds, so the calls a group
	// holds cannot push the answer below them out of sight.
	body := screen.Query("id:process-body")
	if len(body) != 1 {
		t.Fatalf("open groups on screen = %d, want 1", len(body))
	}
	if h := body[0].Frame.Size.Height; h <= 0 || h > 640 {
		t.Fatalf("the open group is %v tall, want between 0 and 640", h)
	}
}
