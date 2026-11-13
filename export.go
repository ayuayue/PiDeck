package main

// A self-contained HTML export of a session, for the sessions pi cannot
// export itself (ACP) and as a fallback when its exporter is unavailable.

import (
	"fmt"
	"html"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/oneo-me/nsgo/ui"
	"github.com/oneo-me/nsgo/ui/chat"
)

// exportData is what the page is built from.
type exportData struct {
	Title   string
	Project string
	Model   string
	Turns   []turn
	Usage   usageInfo
	When    time.Time
}

// sessionHTML builds the page for a session.
func sessionHTML(s *session) string {
	if s == nil {
		return ""
	}
	return renderSessionHTML(exportData{
		Title: s.title.GetUntracked(), Project: s.WS, Model: s.model.GetUntracked().label(),
		Turns: s.turns.GetUntracked(), Usage: s.usage.GetUntracked(), When: time.Now(),
	})
}

// renderSessionHTML draws the page.
func renderSessionHTML(d exportData) string {
	var b strings.Builder
	title := d.Title
	if title == "" {
		title = "PiDeck Lite 会话"
	}
	b.WriteString("<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">")
	b.WriteString("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">")
	fmt.Fprintf(&b, "<title>%s</title>", html.EscapeString(title))
	b.WriteString(`<style>
:root{color-scheme:light dark}body{margin:0;background:#fff;color:#18181b;font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:22px;margin:0 0 4px}.meta{color:#71717a;font-size:12px;margin-bottom:28px}
.turn{margin:0 0 32px;padding:0 0 28px;border-bottom:1px solid #e4e4e7}
.prompt{background:#f4f4f5;border-radius:10px;padding:12px 14px;white-space:pre-wrap;margin-bottom:14px}
.text{white-space:pre-wrap;margin:8px 0}
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
	fmt.Fprintf(&b, "<div class=\"meta\">%s</div>", html.EscapeString(strings.Join(meta, " · ")))
	for _, t := range d.Turns {
		b.WriteString("<section class=\"turn\">")
		if t.Prompt != "" {
			fmt.Fprintf(&b, "<div class=\"prompt\">%s</div>", html.EscapeString(t.Prompt))
		}
		for _, st := range t.Steps {
			if st.Thinking != "" {
				fmt.Fprintf(&b, "<details><summary>思考</summary><div class=\"think\" style=\"white-space:pre-wrap\">%s</div></details>",
					html.EscapeString(st.Thinking))
			}
			if st.Text != "" {
				fmt.Fprintf(&b, "<div class=\"text\">%s</div>", html.EscapeString(st.Text))
			}
			for _, tool := range st.Tools {
				fmt.Fprintf(&b, "<details><summary>%s %s</summary><pre>%s</pre></details>",
					html.EscapeString(tool.Action+" "+tool.Detail), html.EscapeString(statusLabel(tool.Status)),
					html.EscapeString(tool.Output))
			}
		}
		if t.Final != "" {
			fmt.Fprintf(&b, "<div class=\"text\">%s</div>", html.EscapeString(t.Final))
		}
		if t.Err != "" {
			fmt.Fprintf(&b, "<div class=\"err\">%s</div>", html.EscapeString(t.Err))
		}
		b.WriteString("</section>")
	}
	if d.Usage.Total > 0 || d.Usage.Cost > 0 {
		fmt.Fprintf(&b, "<div class=\"meta\">tokens %s · %s</div>", html.EscapeString(tokens(d.Usage.Total)),
			html.EscapeString(credits(d.Usage.Cost)))
	}
	b.WriteString("</main></body></html>")
	return b.String()
}

// statusLabel names a turn's state for the page.
func statusLabel(st chat.Status) string {
	switch st {
	case chat.Completed:
		return "完成"
	case chat.Failed:
		return "失败"
	case chat.Cancelled:
		return "已停止"
	case chat.Running:
		return "运行中"
	case chat.Waiting:
		return "等待"
	}
	return ""
}

// exportSession writes a session's page under the data folder.
func (a *app) exportSession(s *session) {
	if s == nil || a.st == nil {
		return
	}
	dir := filepath.Join(a.st.dir, "exports")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		a.toast(ui.ToastError, "导出失败", err.Error())
		return
	}
	name := sanitizeFileName(s.title.GetUntracked()) + "-" + time.Now().Format("20060102-150405") + ".html"
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(sessionHTML(s)), 0o644); err != nil {
		a.toast(ui.ToastError, "导出失败", err.Error())
		return
	}
	a.diagf("info", "已导出会话 %s 到 %s", s.ID, path)
	a.toastAction(ui.ToastSuccess, "已导出会话", path, "打开", func() {
		a.cx.OpenURL(fileURL(path), nil)
	})
}

// sanitizeFileName keeps a title safe for a file name.
func sanitizeFileName(name string) string {
	name = strings.TrimSpace(firstLine(name, 40))
	if name == "" {
		name = "session"
	}
	repl := strings.NewReplacer("/", "-", "\\", "-", ":", "-", "*", "-", "?", "-",
		"\"", "-", "<", "-", ">", "-", "|", "-")
	return repl.Replace(name)
}
