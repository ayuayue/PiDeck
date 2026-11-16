//go:build !js

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

	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
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

// openExport shows the export choices for a session.
func (a *app) openExport(s *session) {
	if s == nil {
		return
	}
	a.exportID = s.ID
	a.exportOpen.Set(true)
}

// exportDialog offers the formats and the clipboard.
func (a *app) exportDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		row := func(title, desc string, icon func() *core.SVG, testID string, fn func(*session)) core.Node {
			return core.View{
				OnPress: func(core.PressEvent) {
					a.exportOpen.Set(false)
					if s := a.byID[a.exportID]; s != nil {
						fn(s)
					}
				},
				Role: core.RoleButton, Label: title, TestID: testID,
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10, MinHeight: core.Pt(46),
						Padding: core.Symmetric(4, 8), CornerRadius: 7, Hover: &core.Style{Background: colors.Hover()}}
				},
				Children: []core.Node{
					ui.Icon(icon, 15, colors.Muted),
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
						core.Text{Content: T(title), Style: core.Style{FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
						core.Text{Content: T(desc), MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Muted)},
					}},
				},
			}
		}
		return ui.Dialog{
			Open:         a.exportOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.exportOpen.Set(open) },
			Title:        T("导出会话"),
			TestID:       "export-dialog",
			Style:        core.Style{Width: core.Pt(480)},
			Children: []core.Node{
				core.Text{Content: T("写到数据目录的 exports/，或直接复制。"),
					Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Faint)},
				core.View{Style: core.Style{Gap: 2, Margin: core.Edges{Top: 4}}, Children: []core.Node{
					row("HTML 页面", "自包含的单文件，含思考与工具输出。", lucide.FileCode, "export-html",
						func(s *session) { a.exportHTML(s) }),
					row("Markdown 文件", "提问、工具摘要与回答，适合贴进文档。", lucide.FileText, "export-markdown",
						func(s *session) { a.exportMarkdown(s) }),
					row("复制 Markdown", "把整段对话放进剪贴板。", lucide.Copy, "export-copy",
						func(s *session) { a.copyText(sessionMarkdown(s), "Markdown") }),
				}},
			},
			Footer: []core.Node{
				ui.Button{Text: T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.exportOpen.Set(false) }},
			},
		}
	})
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

// sessionMarkdown is a session as Markdown: the prompts, each turn's tools
// and its answer. Answers stay Markdown; prompts go in fences so their
// own backticks cannot break the page.
func sessionMarkdown(s *session) string {
	if s == nil {
		return ""
	}
	return renderSessionMarkdown(exportData{
		Title: s.title.GetUntracked(), Project: s.WS, Model: s.model.GetUntracked().label(),
		Turns: s.turns.GetUntracked(), Usage: s.usage.GetUntracked(), When: time.Now(),
	})
}

// renderSessionMarkdown writes the document.
func renderSessionMarkdown(d exportData) string {
	var b strings.Builder
	title := d.Title
	if title == "" {
		title = "PiDeck Lite 会话"
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
		fmt.Fprintf(&b, "- tokens：%s · 费用：%s\n", tokens(d.Usage.Total), credits(d.Usage.Cost))
	}
	for i, t := range d.Turns {
		fmt.Fprintf(&b, "\n---\n\n## 提问 %d\n\n%s\n", i+1, mdFence(t.Prompt))
		var tools []toolRun
		for _, st := range t.Steps {
			tools = append(tools, st.Tools...)
		}
		if len(tools) > 0 {
			b.WriteString("\n### 工具\n\n")
			for _, tool := range tools {
				line := "- " + tool.Action + " `" + tool.Detail + "`"
				if tool.Added > 0 || tool.Removed > 0 {
					line += fmt.Sprintf(" (+%d −%d)", tool.Added, tool.Removed)
				}
				if label := statusLabel(tool.Status); label != "" && tool.Status != chat.Completed {
					line += " · " + label
				}
				b.WriteString(line + "\n")
			}
		}
		answer := t.Final
		if answer == "" {
			for j := len(t.Steps) - 1; j >= 0; j-- {
				if t.Steps[j].Text != "" {
					answer = t.Steps[j].Text
					break
				}
			}
		}
		if answer != "" {
			fmt.Fprintf(&b, "\n### 回答\n\n%s\n", strings.TrimSpace(answer))
		}
		if t.Err != "" {
			fmt.Fprintf(&b, "\n> 出错：%s\n", t.Err)
		}
	}
	return b.String()
}

// mdFence wraps text in a code fence longer than any run of backticks in
// it, so a prompt's own code blocks cannot close it early.
func mdFence(text string) string {
	fence := "```"
	for strings.Contains(text, fence) {
		fence += "`"
	}
	return fence + "\n" + text + "\n" + fence
}

// exportMarkdown writes a session's Markdown under the data folder.
func (a *app) exportMarkdown(s *session) {
	if s == nil || a.st == nil {
		return
	}
	dir := filepath.Join(a.st.dir, "exports")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		a.toast(ui.ToastError, "导出失败", err.Error())
		return
	}
	name := sanitizeFileName(s.title.GetUntracked()) + "-" + time.Now().Format("20060102-150405") + ".md"
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(sessionMarkdown(s)), 0o644); err != nil {
		a.toast(ui.ToastError, "导出失败", err.Error())
		return
	}
	a.diagf("info", "已导出会话 %s 到 %s", s.ID, path)
	a.toastAction(ui.ToastSuccess, "已导出 Markdown", path, "打开", func() {
		a.cx.OpenURL(fileURL(path), nil)
	})
}
