//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"encoding/json"

	"github.com/nsgo-dev/nsgo/ui/chat"
)

// updateTodos folds a todo tool call into the session's task list: a call
// with the whole list replaces it, and one that creates or marks a single
// item patches the list it leaves.
func (a *app) updateTodos(s *session, toolName string, args json.RawMessage) {
	if s == nil || !isTodoTool(toolName) {
		return
	}
	if items, ok := applyTodoArgs(s.todos.GetUntracked(), args); ok {
		s.todos.Set(items)
	}
}

// toolStarted records a tool the moment it runs.
func (a *app) toolStarted(s *session, ev piEvent) {
	a.updateTodos(s, ev.ToolName, ev.Args)
	action, detail := toolSummary(ev.ToolName, ev.Args)
	run := toolRun{CallID: ev.ToolCallID, Name: ev.ToolName, Action: action, Detail: detail, Status: chat.Running, Start: a.cx.Now()}
	if !a.updateTool(s, run) {
		s.liveTools.Update(func(list []toolRun) []toolRun { return append(list, run) })
	}
}

// toolUpdated publishes a tool's partial output.
func (a *app) toolUpdated(s *session, ev piEvent) {
	run := toolRun{CallID: ev.ToolCallID, Name: ev.ToolName, Output: resultText(ev.PartialResult), Status: chat.Running}
	a.updateTool(s, run)
}

// toolEnded records how a tool finished.
func (a *app) toolEnded(s *session, ev piEvent) {
	var res piToolResult
	_ = json.Unmarshal(ev.Result, &res)
	run := toolRun{CallID: ev.ToolCallID, Name: ev.ToolName, Output: resultText(&res),
		Status: chat.Completed, IsError: ev.IsError, DurationMs: ev.DurationMs}
	run.withDetails(res.Details)
	if ev.IsError {
		run.Status = chat.Failed
	}
	a.updateTool(s, run)
	// A tool that answers with the whole plan leaves the list there, which
	// is the newest word even when its calls only patched one item.
	if isTodoTool(ev.ToolName) {
		if plan, ok := todoPlanFromText(resultText(&res)); ok {
			s.todos.Set(plan)
		}
	}
}

// updateTool merges a run into the live list or a committed step.
func (a *app) updateTool(s *session, run toolRun) bool {
	live := s.liveTools.GetUntracked()
	for i, t := range live {
		if t.CallID == run.CallID {
			live[i] = mergeRun(t, run)
			s.liveTools.Set(live)
			return true
		}
	}
	found := false
	s.turns.Update(func(ts []turn) []turn {
		for i := len(ts) - 1; i >= 0 && !found; i-- {
			for j := len(ts[i].Steps) - 1; j >= 0; j-- {
				for k := range ts[i].Steps[j].Tools {
					if ts[i].Steps[j].Tools[k].CallID == run.CallID {
						ts[i].Steps[j].Tools[k] = mergeRun(ts[i].Steps[j].Tools[k], run)
						found = true
						return ts
					}
				}
			}
		}
		return ts
	})
	return found
}

// mergeRun keeps what is known and takes what the update brings.
func mergeRun(old, next toolRun) toolRun {
	if next.Name != "" {
		old.Name = next.Name
	}
	if next.Action != "" {
		old.Action = next.Action
	}
	if next.Detail != "" {
		old.Detail = next.Detail
	}
	if next.Output != "" {
		old.Output = next.Output
	}
	if len(next.Images) > 0 {
		old.Images = next.Images
	}
	if next.Ask != nil {
		old.Ask = next.Ask
	}
	if next.Diff != "" {
		old.Diff, old.Added, old.Removed = next.Diff, next.Added, next.Removed
	}
	if len(next.Nested) > 0 {
		old.Nested = next.Nested
	}
	if !next.Start.IsZero() {
		old.Start = next.Start
	}
	if next.Status != chat.Running || old.Status == chat.Running {
		old.Status = next.Status
	}
	if next.IsError {
		old.IsError = true
		old.Status = chat.Failed
	}
	if next.DurationMs > 0 {
		old.DurationMs = next.DurationMs
	}
	return old
}
