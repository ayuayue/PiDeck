//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"strings"

	"example.com/pideck-v2/internal/apptext"
)

// replyText is every assistant prose segment, excluding system notes and
// a final answer already mirrored by the last step.
func replyText(t turn) string {
	var parts []string
	for _, st := range t.Steps {
		if st.Note == "" && strings.TrimSpace(st.Text) != "" {
			parts = append(parts, st.Text)
		}
	}
	if final := exportFinal(t); strings.TrimSpace(final) != "" {
		parts = append(parts, final)
	}
	return strings.Join(parts, "\n\n")
}

// replyMarkdown exports one reply without its prompt or neighboring turns.
// Process text is explicit and ordered around the prose using TextAt.
func replyMarkdown(t turn, includeProcess bool) string {
	if !includeProcess {
		return replyText(t)
	}
	var parts []string
	section := func(title, text string) {
		if strings.TrimSpace(text) != "" {
			parts = append(parts, "### "+title+"\n\n"+mdFence(text))
		}
	}
	tools := func(runs []toolRun) {
		for _, run := range runs {
			heading := strings.TrimSpace(run.Action + " " + run.Detail)
			if heading == "" {
				heading = run.Name
			}
			if status := statusLabel(run.Status); status != "" {
				heading += " · " + status
			}
			if run.Added > 0 || run.Removed > 0 {
				heading += fmt.Sprintf(" (+%d −%d)", run.Added, run.Removed)
			}
			text := "### " + apptext.T("工具") + "\n\n" + heading
			if run.Output != "" {
				text += "\n\n" + mdFence(run.Output)
			}
			if run.Diff != "" && run.Diff != run.Output {
				text += "\n\n" + mdFence(run.Diff)
			}
			if len(run.Nested) > 0 {
				text += "\n\n" + mdFence(strings.Join(run.Nested, "\n"))
			}
			parts = append(parts, text)
		}
	}
	for _, st := range t.Steps {
		section(apptext.T("思考"), st.Thinking)
		at := min(max(st.TextAt, 0), len(st.Tools))
		tools(st.Tools[:at])
		if st.Note != "" {
			section(st.Note, st.Text)
		} else if strings.TrimSpace(st.Text) != "" {
			parts = append(parts, st.Text)
		}
		tools(st.Tools[at:])
	}
	if final := exportFinal(t); strings.TrimSpace(final) != "" {
		parts = append(parts, final)
	}
	section(apptext.T("出错"), t.Err)
	return strings.Join(parts, "\n\n")
}
