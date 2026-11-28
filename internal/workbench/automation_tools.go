//go:build !js && !android && !ios

package workbench

// App-owned tools for nsgo mcp: the states a UI test or an agent would other-
// wise reach press by press. NSGo's own steps read and drive what is on
// screen; these say what the app is showing and put it somewhere, so an agent
// spends its turns on the thing under test.
//
// Registration is a no-op outside automation and test builds (see
// core.RegisterAutomationTool), so a release build carries none of it.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/automation"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// automationState is what pideck_state answers: the few values an agent needs
// to know where it is, in JSON rather than read off a snapshot.
type automationState struct {
	Session  string `json:"session"`
	Title    string `json:"title"`
	Page     string `json:"page"`
	Theme    string `json:"theme"`
	Language string `json:"language"`
	Sessions int    `json:"sessions"`
	Turns    int    `json:"turns"`
}

// registerAutomationTools gives nsgo mcp the tools this app adds. A tool whose
// name is taken is a programming error, so it panics here, in the builds that
// have tools at all.
func (a *app) registerAutomationTools() {
	tools := []automation.Tool{
		{
			Name:        "pideck_state",
			Description: "Read the workbench's state: the open session and its title, the page filling the work area, the theme, the language, and how many sessions and turns are showing.",
			InputSchema: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`),
			Handler: func(context.Context, json.RawMessage) (any, error) {
				return a.automationState(), nil
			},
		},
		{
			Name:        "pideck_open_page",
			Description: "Open one of the workbench's pages in the work area, as its tab does: settings, tasks, agents, favorites, review, browser, memory or notifications. Open the page before snapshotting it.",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"page":{"type":"string","enum":["settings","tasks","agents","favorites","review","browser","memory","notifications"]}},"required":["page"],"additionalProperties":false}`),
			Handler:     a.automationOpenPage,
		},
		{
			Name:        "pideck_seed_turns",
			Description: "Append finished turns to the open session without asking pi, for looking at how the transcript draws them: {\"turns\":[{\"prompt\":\"…\",\"answer\":\"…\"}]}. Use it instead of a real prompt when the model is not what is under test.",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"turns":{"type":"array","items":{"type":"object","properties":{"prompt":{"type":"string"},"answer":{"type":"string"}},"required":["prompt"]}}},"required":["turns"],"additionalProperties":false}`),
			Handler:     a.automationSeedTurns,
		},
	}
	for _, tool := range tools {
		if err := automation.Register(a.cx, tool); err != nil {
			panic("workbench: automation tool " + tool.Name + ": " + err.Error())
		}
	}
}

// automationState reads the state on the graph goroutine, which is where a
// tool's handler runs.
func (a *app) automationState() automationState {
	state := automationState{Page: a.activePaneID(), Theme: a.theme.Get(), Language: apptext.CurrentLanguage()}
	if s := a.active(); s != nil {
		state.Session, state.Title = s.ID, s.title.Get()
		state.Turns = len(s.turns.Get())
	}
	for _, ws := range a.workspaces.Get() {
		state.Sessions += len(ws.Sessions.Get())
	}
	return state
}

func (a *app) automationOpenPage(_ context.Context, args json.RawMessage) (any, error) {
	var in struct {
		Page string `json:"page"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, err
	}
	page := strings.TrimSpace(in.Page)
	if _, ok := a.pane(page); !ok {
		return nil, fmt.Errorf("没有这个页面：%q", page)
	}
	a.openPane(page)
	return a.automationState(), nil
}

func (a *app) automationSeedTurns(_ context.Context, args json.RawMessage) (any, error) {
	var in struct {
		Turns []struct {
			Prompt string `json:"prompt"`
			Answer string `json:"answer"`
		} `json:"turns"`
	}
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, err
	}
	s := a.active()
	if s == nil {
		return nil, fmt.Errorf("先打开一个会话")
	}
	if len(in.Turns) == 0 {
		return nil, fmt.Errorf("turns 不能为空")
	}
	now := a.cx.Now()
	turns := append([]turn(nil), s.turns.GetUntracked()...)
	for i, seeded := range in.Turns {
		if strings.TrimSpace(seeded.Prompt) == "" {
			return nil, fmt.Errorf("第 %d 轮的 prompt 是空的", i+1)
		}
		start := now.Add(time.Duration(i) * time.Second)
		turns = append(turns, turn{ID: fmt.Sprintf("seeded-%d-%d", now.UnixNano(), i), Prompt: seeded.Prompt,
			Final: seeded.Answer, Status: chat.Completed, Start: start, End: start.Add(time.Second)})
	}
	s.turns.Set(turns)
	return a.automationState(), nil
}
