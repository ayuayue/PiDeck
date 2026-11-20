package workbench

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestDelegationProjectionUsesTerminalNotice(t *testing.T) {
	var messages []piMessage
	err := json.Unmarshal([]byte(`[
		{"role":"user","content":"review"},
		{"role":"assistant","content":[
			{"type":"toolCall","id":"worker-1","name":"acp_delegate","arguments":{"agent":"reviewer","task":"Check changes"}},
			{"type":"toolCall","id":"workflow-1","name":"subagent","arguments":{"workflowScriptPath":"review.ts"}},
			{"type":"toolCall","id":"query-1","name":"subagent","arguments":{"action":"list"}}
		]},
		{"role":"toolResult","toolCallId":"worker-1","toolName":"acp_delegate","content":"Dispatched runId \u0060del_1\u0060"},
		{"role":"toolResult","toolCallId":"workflow-1","toolName":"subagent","content":"The async run is detached"},
		{"role":"user","content":"[acp_delegate completed] runId \u0060del_1\u0060"}
	]`), &messages)
	if err != nil {
		t.Fatal(err)
	}
	turns := turnsFromMessages(messages)
	entries := delegations(turns, nil)
	if len(entries) != 2 || entries[0].state != "已完成" || entries[0].turnID != turns[0].ID ||
		entries[1].Action != "工作流" || entries[1].state != "已转入后台" {
		t.Fatalf("delegated runs = %+v", entries)
	}
}

func TestDelegationHistoryShowsOriginalResults(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; native runs verify pixels")
	}
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	t.Setenv("PIDECK_LITE_PI_CONFIG", t.TempDir())
	var a *app
	var s *session
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newApp(cx)
		s = a.makeSession(sessionMeta{ID: "history", Title: "History"}, localTarget)
		var tools []toolRun
		for i := range 400 {
			tools = append(tools, toolRun{CallID: fmt.Sprint(i), Name: "subagent", Action: "子代理", Detail: fmt.Sprintf("Task %d", i), Output: fmt.Sprintf("Original result %d", i), Status: chat.Completed})
		}
		s.turns.Set([]turn{{ID: "one", Steps: []turnStep{{Tools: tools}}}})
		return core.View{Style: ui.FillRest, Children: []core.Node{a.delegationOverview(s), a.delegationDialog()}}
	}, nsgotest.Size(1100, 760))
	screen.Press("id:delegate-show-all")
	screen.WaitFor("id:delegate-history-list", 5*time.Second)
	screen.WaitFor("text:Original result 399", 5*time.Second)
	if a.delegationSession.GetUntracked() != s {
		t.Fatal("history opened a different session")
	}
	if len(screen.QueryMounted("role:button")) > 100 {
		t.Fatal("full delegation history was mounted eagerly")
	}
}
