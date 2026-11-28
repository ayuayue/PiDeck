//go:build !js && !android && !ios

package workbench

// The feedback dialog: describe what went wrong, keep the environment and
// the log tail beside it, then copy the report, export the bundle, or
// open a GitHub issue with the report already on the clipboard. No
// conversation text goes in: the report is the diagnostic one.

import (
	"net/url"
	"strings"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// feedbackIssueBase is where a report is sent.
const feedbackIssueBase = "https://github.com/ayuayue/PiDeck/issues/new"

// openFeedback shows the dialog with a fresh report.
func (a *app) openFeedback() {
	a.feedbackReport.Set(a.diagnosticText())
	a.feedbackOpen.Set(true)
}

// feedbackIssueURL is the issue page the dialog opens: the title and the
// note ride in the link, the report itself goes by clipboard, because
// GitHub rejects long query strings.
func feedbackIssueURL(description, report, note string) string {
	text := strings.TrimSpace(description)
	title := apptext.T("问题反馈：%s", viewkit.FirstLine(text, 60))
	if text == "" {
		title = apptext.T("问题反馈")
	}
	body := text
	if summary := feedbackSummary(report); summary != "" {
		body += "\n\n**" + apptext.T("环境") + "**\n\n```\n" + summary + "\n```\n"
	}
	body += "\n" + note
	query := url.Values{}
	query.Set("title", title)
	query.Set("body", strings.TrimSpace(body))
	return feedbackIssueBase + "?" + query.Encode()
}

// feedbackSummary is the head of the report: enough for an issue to say
// what the app ran on, while the whole of it travels by clipboard.
func feedbackSummary(report string) string {
	var out []string
	for _, line := range strings.Split(strings.TrimSpace(report), "\n") {
		line = strings.TrimRight(line, " ")
		if strings.TrimSpace(line) == "" {
			continue
		}
		out = append(out, line)
		if len(out) >= 8 {
			break
		}
	}
	return strings.Join(out, "\n")
}

// feedbackButton is the rail footer's way in.
func (a *app) feedbackButton() core.Node {
	return hint(apptext.T("问题反馈"), ui.IconButton{Icon: lucide.MessageSquarePlus, Label: apptext.T("问题反馈"), Size: 28, IconSize: 14.5,
		TestID: "rail-feedback", OnPress: func() { a.openFeedback() }})
}

// copyFeedbackReport puts the report on the clipboard.
func (a *app) copyFeedbackReport() {
	a.copyText(a.feedbackReport.GetUntracked(), apptext.T("问题反馈"))
	a.toast(ui.ToastSuccess, apptext.T("已复制诊断报告"), apptext.T("粘贴到 Issue 或聊天里即可。"))
}

// openFeedbackIssue copies the report, then opens the issue page.
func (a *app) openFeedbackIssue() {
	report := a.feedbackReport.GetUntracked()
	if strings.TrimSpace(report) != "" {
		a.copyText(report, apptext.T("问题反馈"))
	}
	note := apptext.T("完整报告已在剪贴板，粘贴到下方即可。")
	a.cx.OpenURL(feedbackIssueURL(a.feedbackText.GetUntracked(), report, note), nil)
	a.toast(ui.ToastInfo, apptext.T("已在浏览器打开 GitHub Issue"), apptext.T("诊断报告已复制，粘贴到正文即可。"))
}

// feedbackDialog is the form, the report and the three ways to send it.
func (a *app) feedbackDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		_ = a.langRev.Get()
		report := a.feedbackReport.Get()
		field := core.Style{Padding: core.Symmetric(8, 10), CornerRadius: 8, FontSize: 12.5, LineHeight: 18,
			Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), Color: colors.Text()}
		return ui.Dialog{
			Open:         a.feedbackOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.feedbackOpen.Set(open) },
			Title:        apptext.T("问题反馈"),
			Description:  apptext.T("写清现象和复现步骤。报告只有环境与日志，不含对话内容。"),
			TestID:       "feedback-dialog",
			Style:        core.Style{Width: a.dialogWidth(), MaxHeight: core.Pt(620)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 12}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
					ui.Text(apptext.T("问题描述"), 10.5, ui.Medium, colors.Muted),
					core.Input{Value: a.feedbackText.Get, OnChange: a.feedbackText.Set, Multiline: true,
						Placeholder: apptext.T("例如：点了导出没反应，第二次就好了"), Label: apptext.T("问题描述"), TestID: "feedback-text",
						Style: core.Style{Height: core.Pt(84), Padding: core.Symmetric(8, 10), CornerRadius: 8,
							Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(),
							Color: colors.Text(), FontSize: 12.5, LineHeight: 18},
						StyleFunc: func() core.Style {
							return core.Style{PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
						}},
				}},
				core.View{Style: core.Style{Gap: 6}, Children: []core.Node{
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
						ui.Text(apptext.T("诊断报告"), 10.5, ui.Medium, colors.Muted),
						core.View{Style: core.Style{FlexGrow: 1}},
						ui.Button{Text: apptext.T("重新生成"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "feedback-refresh",
							OnPress: func() { a.feedbackReport.Set(a.diagnosticText()) }},
						ui.Button{Text: apptext.T("复制"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "feedback-copy",
							OnPress: func() { a.copyFeedbackReport() }},
						ui.Button{Text: apptext.T("导出诊断包"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "feedback-bundle",
							OnPress: func() { a.exportDiagnostics() }},
					}},
					a.scrollStashFor("feedbackDialog:1").Bind(cx, core.Scroll{TestID: "feedback-report", Style: core.Style{MaxHeight: core.Pt(220)}, Children: []core.Node{
						core.View{Style: field.Merge(core.Style{Padding: core.All(9)}), Children: []core.Node{
							core.Text{Content: report, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10.5, LineHeight: 15},
								StyleFunc: ui.Colored(colors.Muted)},
						}},
					}}),
				}},
				ui.Text(apptext.T("打开 Issue 前会先把报告复制到剪贴板：GitHub 收不了太长的链接。"), 10.5, ui.Regular, colors.Faint),
			}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.feedbackOpen.Set(false) }},
				ui.Button{Text: apptext.T("打开 GitHub Issue"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall,
					OnPress: func() { a.openFeedbackIssue() }},
			},
		}
	})
}
