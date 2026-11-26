//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"fmt"
	"strings"
	"time"

	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// turnsFromMessages rebuilds the transcript pi reports.
func turnsFromMessages(msgs []piMessage) []turn {
	var turns []turn
	var cur *turn
	flush := func() {
		if cur != nil {
			turns = append(turns, *cur)
			cur = nil
		}
	}
	now := time.Now()
	// A turn begins when its prompt was sent and ends with its last
	// message; a file that lost its timestamps falls back to now.
	at := func(m piMessage) time.Time {
		if m.Timestamp > 0 {
			return time.UnixMilli(m.Timestamp)
		}
		return now
	}
	// pi records each message's own duration, so a session file says how long
	// a call ran and how long a message took without the reader having to
	// subtract two entry times.
	for _, m := range msgs {
		ts := at(m)
		switch m.Role {
		case "user":
			flush()
			blocks := m.blocks()
			text := piBlockText(blocks)
			cur = &turn{ID: fmt.Sprintf("h%d", len(turns)), sourceEntryID: m.EntryID, sourcePrompt: text,
				Prompt: text, Images: piBlockImages(blocks), Status: chat.Completed, Start: ts, End: ts}
		case "assistant":
			if cur == nil {
				cur = &turn{ID: fmt.Sprintf("h%d", len(turns)), Status: chat.Completed, Start: ts, End: ts}
			}
			if m.Model != "" {
				cur.Model = m.Model
			}
			step := turnStep{ID: fmt.Sprintf("h%d-%d", len(turns), len(cur.Steps))}
			// What the message took to arrive is what it spent reasoning and
			// answering before it acted.
			step.Think = time.Duration(m.DurationMs) * time.Millisecond
			var prose strings.Builder
			var calls []piContent
			proseAt := -1
			for _, b := range m.blocks() {
				switch b.Type {
				case "thinking":
					step.Thinking += b.Thinking
				case "text":
					if proseAt < 0 {
						proseAt = len(calls)
					}
					if prose.Len() > 0 {
						prose.WriteString("\n\n")
					}
					prose.WriteString(b.Text)
				case "toolCall":
					calls = append(calls, b)
				}
			}
			if prose.Len() > 0 && len(calls) > 0 {
				step.Text = prose.String()
				step.TextAt = max(0, proseAt)
			}
			for _, c := range calls {
				action, detail := toolSummary(c.Name, c.Arguments)
				step.Tools = append(step.Tools, toolRun{CallID: c.ID, Name: c.Name, Action: action, Detail: detail,
					filePaths: toolFileArgs(c.Arguments), Status: chat.Completed})
				cur.Tools++
			}
			if len(calls) == 0 && prose.Len() > 0 {
				cur.Final = prose.String()
			}
			if m.Usage != nil {
				cur.Usage = cur.Usage.add(usageInfo{Input: m.Usage.Input, Output: m.Usage.Output,
					CacheRead: m.Usage.CacheRead, CacheWrite: m.Usage.CacheWrite, Total: m.Usage.Total,
					Cost: m.Usage.Cost.Total})
			}
			if m.StopReason == "error" && m.ErrorMsg != "" {
				cur.Err = m.ErrorMsg
				cur.Status = chat.Failed
			}
			if step.Text != "" || step.Thinking != "" || len(step.Tools) > 0 {
				cur.Steps = append(cur.Steps, step)
			}
		case "toolResult":
			run := toolRunFromResult(m)
			if cur != nil {
				updated := false
				for i := range cur.Steps {
					for j := range cur.Steps[i].Tools {
						if cur.Steps[i].Tools[j].CallID == run.CallID {
							cur.Steps[i].Tools[j] = mergeRun(cur.Steps[i].Tools[j], run)
							updated = true
						}
					}
				}
				if !updated {
					cur.Steps = append(cur.Steps, turnStep{ID: fmt.Sprintf("h%d-tr%d", len(turns), len(cur.Steps)),
						Tools: []toolRun{mergeRun(toolRun{CallID: run.CallID, Name: run.Name, Action: "工具", Status: chat.Completed}, run)}})
				}
			}
		case "bashExecution":
			if cur == nil {
				cur = &turn{ID: fmt.Sprintf("h%d", len(turns)), Status: chat.Completed, Start: ts, End: ts}
			}
			run := toolRun{CallID: "bash-" + fmt.Sprint(len(cur.Steps)), Name: "bash", Action: "运行", Detail: viewkit.FirstLine(m.Command, 90),
				Output: strings.TrimSpace(m.Output), Status: chat.Completed, DurationMs: m.DurationMs,
				IsError: m.ExitCode != nil && *m.ExitCode != 0}
			if run.IsError {
				run.Status = chat.Failed
			}
			cur.Steps = append(cur.Steps, turnStep{ID: fmt.Sprintf("h%d-bash%d", len(turns), len(cur.Steps)), Tools: []toolRun{run}})
			cur.Tools++
		case "compactionSummary", "branchSummary":
			if cur == nil {
				turns = append(turns, turn{ID: fmt.Sprintf("h%d", len(turns)), Status: chat.Completed, Start: ts, End: ts,
					Steps: []turnStep{{ID: "summary", Note: "上下文摘要", Text: m.Summary}}})
			} else {
				cur.Steps = append(cur.Steps, turnStep{ID: fmt.Sprintf("h%d-sum", len(turns)), Note: "上下文摘要", Text: m.Summary})
			}
		case "custom":
			if cur == nil {
				turns = append(turns, turn{ID: fmt.Sprintf("h%d", len(turns)), Status: chat.Completed, Start: ts, End: ts,
					Steps: []turnStep{{ID: "custom", Note: m.CustomType, Text: m.text()}}})
			} else {
				cur.Steps = append(cur.Steps, turnStep{ID: fmt.Sprintf("h%d-custom%d", len(turns), len(cur.Steps)), Note: m.CustomType, Text: m.text()})
			}
		}
		if cur != nil && ts.After(cur.End) {
			cur.End = ts
		}
	}
	flush()
	for i := range turns {
		if turns[i].Start.IsZero() {
			turns[i].Start = now
		}
	}
	return turns
}
