//go:build !js && !android && !ios

package workbench

// The settings window: a rail of sections beside the section's rows. Each
// row says what it is in a line and why in a quieter one, and the control
// sits at its end, so a section reads top to bottom.

import (
	"fmt"
	"path/filepath"
	"runtime"
	"strings"

	"example.com/pideck-v2/internal/appinfo"
	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/crashlog"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// diagLogLines is how many log lines the page shows at most; the whole log
// stays in the file beside it.
const diagLogLines = 12

// settingsDiagnostics shows what is running and what went wrong. The scroll
// view is built once: its groups read signals that a slow tick fills, so the
// figures move without the page rebuilding - a page rebuilt every second used
// to throw the reader back to its top.
func (a *app) settingsDiagnostics(cx *core.Scope) core.Node {
	return a.scrollStashFor("settingsDiagnostics:1").Bind(cx, core.Scroll{TestID: "settings-page",
		Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: 2}, Gap: 4}, Children: []core.Node{
				a.diagRuntimeGroup(),
				a.diagProcessGroup(),
				a.diagLogGroup(),
				a.diagCrashGroup(),
				a.trajectorySetting(),
				a.diagActions(),
			}},
		}})
}

// diagRuntimeGroup is the version, then what this process holds right now.
func (a *app) diagRuntimeGroup() core.Node {
	return setGroup("运行",
		setRow("版本", fmt.Sprintf("%s · %s/%s · Go %s", appinfo.Version, runtime.GOOS, runtime.GOARCH, runtime.Version()), nil),
		setDivider(),
		core.Dynamic(func(cx *core.Scope) core.Node {
			colors := ui.ColorsOf(cx)
			m := a.diagMem.Get()
			share := float32(0)
			if m.HeapSys > 0 {
				share = float32(float64(m.HeapAlloc) * 100 / float64(m.HeapSys))
			}
			return core.View{Style: core.Style{Gap: 9, Padding: core.Symmetric(8, 2)}, Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignEnd, Gap: 16}, Children: []core.Node{
					diagFigure("已用", memText(m.HeapAlloc), colors.Text, colors.Faint),
					diagFigure("已提交", memText(m.HeapSys), colors.Text, colors.Faint),
					diagFigure("空闲", memText(m.HeapIdle), colors.Muted, colors.Faint),
					diagFigure("goroutine", fmt.Sprint(m.Goroutines), colors.Text, colors.Faint),
					diagFigure("已运行", duration(m.Uptime), colors.Text, colors.Faint),
				}},
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 12}, Children: []core.Node{
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
						ui.Progress{Value: func() float32 { return share }, Label: apptext.T("堆占用"), TestID: "diag-heap"},
					}},
					ui.Button{Text: apptext.T("释放内存"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						TestID: "diag-release", OnPress: a.releaseMemory},
				}},
			}}
		}),
	)
}

// diagFigure is one number of the runtime row: what it is above, its value
// below.
func diagFigure(label, value string, valueColor, labelColor func() core.Color) core.Node {
	return core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
		ui.Text(apptext.T(label), 9.5, ui.Regular, labelColor),
		ui.Text(value, 13, ui.Semibold, valueColor),
	}}
}

// memText says a heap size the way a dashboard reads: fractions of a
// gigabyte once it is one, whole megabytes below.
func memText(bytes uint64) string {
	if bytes >= 1<<30 {
		return fmt.Sprintf("%.2f GB", float64(bytes)/(1<<30))
	}
	return fmt.Sprintf("%.0f MB", float64(bytes)/(1<<20))
}

// diagProcessGroup lists what the app runs, each with a way to stop it.
func (a *app) diagProcessGroup() core.Node {
	return setGroup("进程", core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		procs := a.diagProcs.Get()
		if procs == nil || len(*procs) == 0 {
			return core.View{Style: core.Style{Gap: 2, Padding: core.Symmetric(9, 2)}, Children: []core.Node{
				ui.Text(apptext.T("没有运行中的进程"), 12.5, ui.Regular, colors.Text),
				ui.Text(apptext.T("打开会话或终端后会出现在这里。"), 11, ui.Regular, colors.Muted),
			}}
		}
		var rows []core.Node
		for i, p := range *procs {
			rows = append(rows, a.diagProcRow(p, colors))
			if i < len(*procs)-1 {
				rows = append(rows, setDivider())
			}
		}
		return core.View{Style: core.Style{Gap: 2}, Children: rows}
	}))
}

// diagProcRow is one process: what kind it is, what it runs, its state and
// the button that ends it.
func (a *app) diagProcRow(p procInfo, colors ui.Colors) core.Node {
	kind, variant := "pi", ui.BadgeInfo
	if p.Kind == "shell" {
		kind, variant = "shell", ui.BadgeNeutral
	}
	detail := p.Detail
	if p.PID > 0 {
		detail += fmt.Sprintf(" · pid %d", p.PID)
	}
	if p.Stderr != "" {
		detail += " · " + p.Stderr
	}
	children := []core.Node{
		ui.Badge{Text: kind, Variant: variant},
		// A name and its path stay on one line each: a long path ellipsizes
		// in the middle, where the interesting end is.
		core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
			core.Text{Content: p.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FontSize: 12.5, LineHeight: 17}, StyleFunc: ui.Colored(colors.Text)},
			core.Text{Content: detail, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10, LineHeight: 14}, StyleFunc: ui.Colored(colors.Muted)},
		}},
		diagStateBadge(p.State),
	}
	if p.CanStop {
		proc := p
		children = append(children, ui.Button{Text: apptext.T("停止"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
			TestID: "diag-stop-" + p.Kind + "-" + p.ID, OnPress: func() { a.askStopProcess(proc) }})
	}
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10, MinHeight: core.Pt(40),
		Padding: core.Symmetric(4, 2)}, Children: children}
}

// diagStateBadge is a process state as one capsule.
func diagStateBadge(state string) core.Node {
	variant := ui.BadgeNeutral
	switch state {
	case "运行中":
		variant = ui.BadgeAccent
	case "启动中", "等待":
		variant = ui.BadgeWarn
	case "失败":
		variant = ui.BadgeDanger
	}
	return ui.Badge{Text: apptext.T(state), Variant: variant}
}

// askStopProcess confirms ending a process before it is ended.
func (a *app) askStopProcess(p procInfo) {
	if p.Kind == "pi" {
		a.askConfirm(apptext.T("停止会话进程"), fmt.Sprintf(apptext.T(
			"%s 的 pi 进程会被结束，正在执行的回合会中断；会话与转录保留，下次发消息会重新启动。"), p.Name), apptext.T("停止"),
			func() { a.stopProcess(p) })
		return
	}
	a.askConfirm(apptext.T("关闭终端"), fmt.Sprintf(apptext.T("%s 的终端会被关闭，正在运行的命令会中断。"), p.Name), apptext.T("停止"),
		func() { a.stopProcess(p) })
}

// diagLogGroup is the newest log lines, oldest first.
func (a *app) diagLogGroup() core.Node {
	return setGroup("最近日志", core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		snapshot := a.diagLog.Get()
		if snapshot == nil || len(*snapshot) == 0 {
			return core.View{Style: core.Style{Padding: core.Symmetric(9, 2)}, Children: []core.Node{
				ui.Text(apptext.T("还没有日志。"), 11, ui.Regular, colors.Faint),
			}}
		}
		events := *snapshot
		start := max(0, len(events)-diagLogLines)
		var rows []core.Node
		for _, ev := range events[start:] {
			tone := colors.Muted
			switch ev.Level {
			case "error":
				tone = colors.Danger
			case "warn":
				tone = colors.Warn
			}
			rows = append(rows, core.View{Style: core.Style{Direction: core.Row, Gap: 8, Padding: core.Symmetric(1, 2)}, Children: []core.Node{
				core.Text{Content: ev.Time.Format("15:04:05"), Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5, LineHeight: 14},
					StyleFunc: ui.Colored(colors.Faint)},
				core.Text{Content: ev.Text, MaxLines: 2, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5, LineHeight: 14, FlexShrink: 1},
					StyleFunc: ui.Colored(tone)},
			}})
		}
		hint := ""
		if len(events) > diagLogLines {
			hint = fmt.Sprintf(apptext.T("只显示最近 %d 条；完整日志在 logs/pideck.log。"), diagLogLines)
		}
		rows = append(rows, core.Text{Content: hint, Style: core.Style{FontSize: 9.5, LineHeight: 15, Margin: core.Edges{Left: 2, Top: 3}},
			StyleFunc: ui.Colored(colors.Faint)})
		return core.View{Style: core.Style{Gap: 1, Padding: core.Symmetric(6, 2)}, Children: rows}
	}))
}

// diagCrashGroup is the last crash, if there is one.
func (a *app) diagCrashGroup() core.Node {
	if path, at, ok := crashlog.Latest(a.dataDir); ok {
		return setGroup("崩溃",
			setRow("最近崩溃", at.Format("2006-01-02 15:04:05")+" · "+filepath.Base(path),
				core.View{Style: core.Style{Direction: core.Row, Gap: 6}, Children: []core.Node{
					ui.Button{Text: apptext.T("查看"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "crash-view",
						OnPress: func() { a.openEditorFile(filepath.Dir(path), path) }},
					ui.Button{Text: apptext.T("打开目录"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "crash-dir",
						OnPress: func() { a.openResourcesDir(crashlog.Dir(a.dataDir)) }},
				}}),
			setDivider(),
			setRow("崩溃日志", fmt.Sprintf("共 %d 个文件；panic 时自动写入数据目录的 crashes/。", crashlog.Count(a.dataDir)), nil),
		)
	}
	return setGroup("崩溃",
		setRow("崩溃日志", "还没有崩溃记录；panic 时自动写到数据目录的 crashes/。", nil))
}

// diagActions are the things a bug report and a log needs.
func (a *app) diagActions() core.Node {
	return core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6, Margin: core.Edges{Top: 2}}, Children: []core.Node{
		ui.Button{Text: apptext.T("复制诊断信息"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "diag-copy",
			OnPress: func() { a.copyText(a.diagnosticText(), "诊断信息") }},
		ui.Button{Text: apptext.T("导出诊断包"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "diag-bundle",
			OnPress: a.exportDiagnostics},
		ui.Button{Text: apptext.T("打开日志目录"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
			if dir := a.diagDir(); dir != "" {
				a.cx.OpenURL(fileURL(dir), nil)
			}
		}},
		core.View{Style: core.Style{FlexGrow: 1}},
		ui.Button{Text: apptext.T("清空内存日志"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
			a.clearDiag()
			a.diagRefresh()
			a.toast(ui.ToastInfo, "内存日志已清空", "日志文件仍在数据目录的 logs 下。")
		}},
	}}
}

// detectedEditorsText names the editors found on PATH.
func detectedEditorsText() string {
	list := detectEditors()
	if len(list) == 0 {
		return apptext.T("没有在 PATH 里找到常见编辑器；可以填一个命令。")
	}
	names := make([]string, 0, len(list))
	for _, e := range list {
		names = append(names, e.Name)
	}
	return apptext.T("已找到：") + strings.Join(names, ", ")
}
