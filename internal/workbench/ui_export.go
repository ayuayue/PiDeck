//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) openExport(s *session) {
	if s == nil {
		return
	}
	a.exportID = s.ID
	a.exportOriginal.Set(false)
	a.exportOpen.Set(true)
}

func (a *app) exportDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		mode := func(text, id string, original bool) core.Node {
			return ui.ToggleButton{
				Text: text, TestID: id,
				On: func() bool { return a.exportOriginal.Get() == original },
				OnChange: func(on bool) {
					if on {
						a.exportOriginal.Set(original)
					}
				},
			}
		}
		row := func(title string, icon func() *core.SVG, id string, format exportFormat) core.Node {
			return base.Button{
				OnPress: func(core.PressEvent) {
					a.exportOpen.Set(false)
					a.runSessionExport(a.findSession(a.exportID), format, a.exportOriginal.GetUntracked())
				},
				Label: title, TestID: id,
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10,
						MinHeight: core.Pt(44), Padding: core.Symmetric(6, 8), CornerRadius: ui.RadiusControl,
						Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()},
						FocusVisible: ui.FocusRing(cx, 2)}
				},
				Children: []core.Node{
					ui.Icon(icon, 15, colors.Muted),
					ui.Text(title, 13, ui.Regular, colors.Text),
				},
			}
		}
		return ui.Dialog{
			Open:         a.exportOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.exportOpen.Set(open) },
			Title:        apptext.T("导出会话"),
			TestID:       "export-dialog",
			Style:        core.Style{Width: a.dialogWidth(), MaxWidth: core.Pt(480)},
			Children: []core.Node{
				ui.ToggleGroup{Label: apptext.T("导出内容"), Style: core.Style{Wrap: core.Wrap}, Children: []core.Node{
					mode(apptext.T("分享副本"), "export-mode-share", false),
					mode(apptext.T("原始内容"), "export-mode-original", true),
				}},
				core.Text{ContentFunc: func() string {
					if a.exportOriginal.Get() {
						return apptext.T("可能包含项目路径和凭据。")
					}
					return apptext.T("仅提问与回答，遮盖常见路径与凭据。分享前请检查副本。")
				}, Style: core.Style{FontSize: 12, LineHeight: 17}, StyleFunc: ui.Colored(colors.Muted)},
				core.View{Style: core.Style{Gap: 2}, Children: []core.Node{
					row(apptext.T("HTML 页面"), lucide.FileCode, "export-html", exportHTMLFile),
					row(apptext.T("Markdown 文件"), lucide.FileText, "export-markdown", exportMarkdownFile),
					row(apptext.T("复制 Markdown"), lucide.Copy, "export-copy", exportClipboard),
				}},
			},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("取消"), TestID: "export-cancel", Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.exportOpen.Set(false) }},
			},
		}
	})
}
