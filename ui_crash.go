//go:build !js

package main

// The crash screen: what replaces the interface when something under it
// panicked. It writes the crash log once and offers to reload the screen.

import (
	"path/filepath"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// crashScreen replaces a panicking screen: it logs the panic, shows what
// happened, and can build the screen again.
func (a *app) crashScreen(cx *core.Scope, err error, reset func()) core.Node {
	if err != nil && a.crashShown != err.Error() {
		a.crashShown = err.Error()
		if path, werr := writeCrashReport(a.dataDir, err, nil); werr == nil {
			a.crashPath = path
		}
	}
	return crashScreenFor(cx, err, reset, a.crashPath,
		func(path string) { a.openEditorFile(filepath.Dir(path), path) },
		func(text string) { a.copyText(text, "错误") })
}

// crashScreenFor draws the boundary's fallback, with how to open the log
// and copy the error.
func crashScreenFor(cx *core.Scope, err error, reset func(), logPath string, open func(string), copyText func(string)) core.Node {
	colors := ui.ColorsOf(cx)
	detail := ""
	if err != nil {
		detail = err.Error()
	}
	logged := T("崩溃日志没能写入。")
	if logPath != "" {
		logged = T("已写入崩溃日志：") + logPath
	}
	card := []core.Node{
		ui.Icon(lucide.ShieldAlert, 28, colors.Danger),
		core.Text{Content: T("界面出了点问题"), Style: core.Style{FontSize: 17, FontWeight: ui.Semibold, TextAlign: core.TextAlignCenter},
			StyleFunc: ui.Colored(colors.Text)},
		core.Text{Content: T("这一屏被错误拦下了，应用还在运行。可以重新加载这一屏。"),
			Style: core.Style{FontSize: 12, LineHeight: 18, TextAlign: core.TextAlignCenter}, StyleFunc: ui.Colored(colors.Muted)},
	}
	if detail != "" {
		card = append(card, core.Scroll{Style: core.Style{MaxHeight: core.Pt(180), Width: core.Pct(100), Padding: core.All(9),
			Background: colors.Inset(), CornerRadius: 8, BorderWidth: 1, BorderColor: colors.Border()}, Children: []core.Node{
			core.Text{Content: detail, Selectable: core.SelectableOn,
				Style: core.Style{FontFamily: ui.Mono, FontSize: 10, LineHeight: 15}, StyleFunc: ui.Colored(colors.Danger)},
		}})
	}
	card = append(card, core.Text{Content: logged, MaxLines: 2, EllipsizeMode: core.EllipsizeMiddle,
		Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5, TextAlign: core.TextAlignCenter}, StyleFunc: ui.Colored(colors.Faint)})
	buttons := []core.Node{
		ui.Button{Text: T("重新加载界面"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "crash-reset", OnPress: reset},
	}
	if logPath != "" && open != nil {
		path := logPath
		buttons = append(buttons, ui.Button{Text: T("打开崩溃日志"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "crash-open",
			OnPress: func() { open(path) }})
	}
	if detail != "" && copyText != nil {
		buttons = append(buttons, ui.Button{Text: T("复制错误"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "crash-copy",
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
