//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"html"
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

// exportData is what the page is built from.
type exportData struct {
	Title   string
	Project string
	Model   string
	Turns   []turn
	Usage   usageInfo
	When    time.Time
	Shared  bool
}

// renderSessionHTML draws the page.
func renderSessionHTML(d exportData) string {
	var b strings.Builder
	title := d.Title
	if title == "" {
		title = "PiDeck V2 会话"
	}
	fmt.Fprintf(&b, `<!doctype html><html lang="%s"><head><meta charset="utf-8">`, html.EscapeString(apptext.CurrentLanguage()))
	b.WriteString("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">")
	fmt.Fprintf(&b, "<title>%s</title>", html.EscapeString(title))
	b.WriteString(`<style>
:root{color-scheme:light dark}body{margin:0;background:#fff;color:#18181b;font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:22px;margin:0 0 4px}.meta{color:#71717a;font-size:12px;margin-bottom:28px}
.turn{margin:0 0 32px;padding:0 0 28px;border-bottom:1px solid #e4e4e7}
.prompt{background:#f4f4f5;border-radius:10px;padding:12px 14px;white-space:pre-wrap;margin-bottom:14px;overflow-wrap:anywhere}
.text{white-space:pre-wrap;margin:8px 0;overflow-wrap:anywhere}
.think{color:#71717a;font-size:12.5px;margin:6px 0}
details{margin:8px 0}summary{cursor:pointer;color:#52525b;font-size:12.5px}
pre{background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;padding:10px;overflow:auto;white-space:pre-wrap;font-size:12px}
.tool{color:#3f3f46;font-size:12.5px}.err{color:#b42318}.ok{color:#14703a}
@media (prefers-color-scheme:dark){body{background:#121212;color:#ededed}.meta,.think,summary{color:#a1a1a1}
.prompt{background:#1f1f1f}pre{background:#171717;border-color:#2a2a2a}.turn{border-color:#2a2a2a}.err{color:#f0958f}.ok{color:#79bea1}}
</style></head><body><main>`)
	fmt.Fprintf(&b, "<h1>%s</h1>", html.EscapeString(title))
	meta := []string{}
	if d.Project != "" {
		meta = append(meta, d.Project)
	}
	if d.Model != "" {
		meta = append(meta, d.Model)
	}
	if !d.When.IsZero() {
		meta = append(meta, d.When.Format("2006-01-02 15:04"))
	}
	if len(meta) > 0 {
		fmt.Fprintf(&b, "<div class=\"meta\">%s</div>", html.EscapeString(strings.Join(meta, " · ")))
	}
	for _, t := range d.Turns {
		b.WriteString("<section class=\"turn\">")
		if t.Prompt != "" {
			fmt.Fprintf(&b, "<div class=\"prompt\">%s</div>", html.EscapeString(t.Prompt))
		}
		for _, st := range t.Steps {
			if st.Thinking != "" {
				fmt.Fprintf(&b, "<details><summary>%s</summary><div class=\"think\" style=\"white-space:pre-wrap\">%s</div></details>",
					html.EscapeString(apptext.T("思考")), html.EscapeString(st.Thinking))
			}
			if st.Note != "" {
				fmt.Fprintf(&b, "<details><summary>%s</summary><div class=\"text\">%s</div></details>",
					html.EscapeString(st.Note), html.EscapeString(st.Text))
			} else if st.Text != "" {
				fmt.Fprintf(&b, "<div class=\"text\">%s</div>", html.EscapeString(st.Text))
			}
			for _, tool := range st.Tools {
				fmt.Fprintf(&b, "<details><summary>%s %s</summary><pre>%s</pre></details>",
					html.EscapeString(tool.Action+" "+tool.Detail), html.EscapeString(statusLabel(tool.Status)),
					html.EscapeString(tool.Output))
			}
		}
		if final := exportFinal(t); final != "" {
			fmt.Fprintf(&b, "<div class=\"text\">%s</div>", html.EscapeString(final))
		}
		if t.Err != "" {
			fmt.Fprintf(&b, "<div class=\"err\">%s</div>", html.EscapeString(t.Err))
		}
		b.WriteString("</section>")
	}
	if d.Usage.Total > 0 || d.Usage.Cost > 0 {
		fmt.Fprintf(&b, "<div class=\"meta\">tokens %s · %s</div>", html.EscapeString(viewkit.Tokens(d.Usage.Total)),
			html.EscapeString(viewkit.Credits(d.Usage.Cost)))
	}
	b.WriteString("</main></body></html>")
	return b.String()
}

// statusLabel names a turn's state for the page.
func statusLabel(st chat.Status) string {
	switch st {
	case chat.Completed:
		return apptext.T("完成")
	case chat.Failed:
		return apptext.T("失败")
	case chat.Cancelled:
		return apptext.T("已停止")
	case chat.Running:
		return apptext.T("运行中")
	case chat.Waiting:
		return apptext.T("等待中")
	}
	return ""
}

// sanitizeFileName keeps a title safe for a file name.
func sanitizeFileName(name string) string {
	name = strings.TrimSpace(viewkit.FirstLine(name, 40))
	if name == "" {
		name = "session"
	}
	repl := strings.NewReplacer("/", "-", "\\", "-", ":", "-", "*", "-", "?", "-",
		"\"", "-", "<", "-", ">", "-", "|", "-")
	return repl.Replace(name)
}

// renderSessionMarkdown writes the document.
func renderSessionMarkdown(d exportData) string {
	var b strings.Builder
	title := d.Title
	if title == "" {
		title = "PiDeck V2 会话"
	}
	fmt.Fprintf(&b, "# %s\n\n", title)
	if d.Project != "" {
		fmt.Fprintf(&b, "- 项目：`%s`\n", d.Project)
	}
	if d.Model != "" {
		fmt.Fprintf(&b, "- 模型：%s\n", d.Model)
	}
	if !d.When.IsZero() {
		fmt.Fprintf(&b, "- 时间：%s\n", d.When.Format("2006-01-02 15:04"))
	}
	if d.Usage.Total > 0 || d.Usage.Cost > 0 {
		fmt.Fprintf(&b, "- tokens：%s · 费用：%s\n", viewkit.Tokens(d.Usage.Total), viewkit.Credits(d.Usage.Cost))
	}
	for i, t := range d.Turns {
		if t.Prompt != "" || !d.Shared {
			fmt.Fprintf(&b, "\n---\n\n## %s\n\n%s\n", apptext.T("提问 %d", i+1), mdFence(t.Prompt))
		} else {
			b.WriteString("\n---\n")
		}
		for _, st := range t.Steps {
			if st.Thinking != "" {
				fmt.Fprintf(&b, "\n### %s\n\n%s\n", apptext.T("思考"), mdFence(st.Thinking))
			}
			if st.Note != "" {
				fmt.Fprintf(&b, "\n### %s\n\n%s\n", st.Note, mdFence(st.Text))
			} else if st.Text != "" {
				fmt.Fprintf(&b, "\n### %s\n\n%s\n", apptext.T("回答"), st.Text)
			}
			if len(st.Tools) > 0 {
				fmt.Fprintf(&b, "\n### %s\n\n", apptext.T("工具"))
			}
			for _, tool := range st.Tools {
				line := "- " + tool.Action + " `" + tool.Detail + "`"
				if tool.Added > 0 || tool.Removed > 0 {
					line += fmt.Sprintf(" (+%d −%d)", tool.Added, tool.Removed)
				}
				if label := statusLabel(tool.Status); label != "" && tool.Status != chat.Completed {
					line += " · " + label
				}
				b.WriteString(line + "\n")
				if tool.Output != "" {
					fmt.Fprintf(&b, "\n%s\n\n", mdFence(tool.Output))
				}
			}
		}
		if answer := exportFinal(t); strings.TrimSpace(answer) != "" {
			if d.Shared {
				// Shared text stays inert when pasted into a Markdown renderer.
				answer = mdFence(answer)
			}
			fmt.Fprintf(&b, "\n### %s\n\n%s\n", apptext.T("回答"), answer)
		}
		if t.Err != "" {
			fmt.Fprintf(&b, "\n> 出错：%s\n", t.Err)
		}
	}
	return b.String()
}

// Some transcripts mirror the last step's prose into Final. It is already
// rendered with that step; earlier repeated text and system notes are distinct.
func exportFinal(t turn) string {
	if len(t.Steps) > 0 {
		last := t.Steps[len(t.Steps)-1]
		if last.Note == "" && last.Text == t.Final {
			return ""
		}
	}
	return t.Final
}

// Sharing can fall back to an assistant's prose, never to a system note.
func exportAnswer(t turn) string {
	if answer := strings.TrimSpace(t.Final); answer != "" {
		return answer
	}
	for i := len(t.Steps) - 1; i >= 0; i-- {
		if answer := strings.TrimSpace(t.Steps[i].Text); answer != "" && t.Steps[i].Note == "" {
			return answer
		}
	}
	return ""
}

// mdFence wraps text in a code fence longer than any run of backticks in
// it, so a prompt's own code blocks cannot close it early.
func mdFence(text string) string {
	longest, run := 2, 0
	for i := range len(text) {
		if text[i] == '`' {
			run++
			longest = max(longest, run)
		} else {
			run = 0
		}
	}
	fence := strings.Repeat("`", longest+1)
	return fence + "\n" + text + "\n" + fence
}
