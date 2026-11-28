package viewkit

// The crash screen both builds show: the workbench's boundary and the
// client's one draw the same fallback.

import (
	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// crashScreenFor draws the boundary's fallback, with how to open the log
// and copy the error.
func CrashScreen(cx *core.Scope, err error, reset func(), logPath string, open func(string), copyText func(string)) core.Node {
	colors := ui.ColorsOf(cx)
	detail := ""
	if err != nil {
		detail = err.Error()
	}
	logged := apptext.T("崩溃日志没能写入。")
	if logPath != "" {
		logged = apptext.T("已写入崩溃日志：") + logPath
	}
	card := []core.Node{
		ui.Icon(lucide.ShieldAlert, 28, colors.Danger),
		core.Text{Content: apptext.T("界面出了点问题"), Style: core.Style{FontSize: 17, FontWeight: ui.Semibold, TextAlign: core.TextAlignCenter},
			StyleFunc: ui.Colored(colors.Text)},
		core.Text{Content: apptext.T("这一屏被错误拦下了，应用还在运行。可以重新加载这一屏。"),
			Style: core.Style{FontSize: 12, LineHeight: 18, TextAlign: core.TextAlignCenter}, StyleFunc: ui.Colored(colors.Muted)},
	}
	if detail != "" {
		card = append(card, core.Scroll{TestID: "crash-detail-scroll", Style: core.Style{MaxHeight: core.Pt(180), Width: core.Pct(100), Padding: core.All(9),
			Background: colors.Inset(), CornerRadius: 8, BorderWidth: 1, BorderColor: colors.Border()}, Children: []core.Node{
			core.Text{Content: detail, Selectable: core.SelectableOn,
				Style: core.Style{FontFamily: MonoFont(), FontSize: 10, LineHeight: 15, Padding: core.Edges{Right: PanelInset}}, StyleFunc: ui.Colored(colors.Danger)},
		}})
	}
	card = append(card, core.Text{Content: logged, MaxLines: 2, EllipsizeMode: core.EllipsizeMiddle,
		Style: core.Style{FontFamily: MonoFont(), FontSize: 9.5, TextAlign: core.TextAlignCenter}, StyleFunc: ui.Colored(colors.Faint)})
	buttons := []core.Node{
		ui.Button{Text: apptext.T("重新加载界面"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "crash-reset", OnPress: reset},
	}
	if logPath != "" && open != nil {
		path := logPath
		buttons = append(buttons, ui.Button{Text: apptext.T("打开崩溃日志"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "crash-open",
			OnPress: func() { open(path) }})
	}
	if detail != "" && copyText != nil {
		buttons = append(buttons, ui.Button{Text: apptext.T("复制错误"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "crash-copy",
			OnPress: func() { copyText(detail) }})
	}
	card = append(card, core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6, JustifyContent: core.JustifyCenter}, Children: buttons})
	return core.View{TestID: "crash-screen", Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
		Padding: core.All(28)}, StyleFunc: func() core.Style { return core.Style{Background: colors.Background()} },
		Children: []core.Node{core.View{Style: core.Style{AlignItems: core.AlignCenter, Gap: 10, Width: core.Pct(100), MaxWidth: core.Pt(560)},
			Children: card}}}
}

// filepathDir is a path's folder, without importing path/filepath here.
func filepathDir(path string) string {
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '/' || path[i] == '\\' {
			return path[:i]
		}
	}
	return path
}
