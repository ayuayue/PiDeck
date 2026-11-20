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
	"time"

	"example.com/pideck-lite/internal/appinfo"
	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/crashlog"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// settingsDiagnostics shows what is running and what went wrong.
func (a *app) settingsDiagnostics() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		// Redrawn when any setting changes: their values live in the config.
		a.settingsTick()
		colors := ui.ColorsOf(cx)
		_ = a.clock.Get()
		var mem runtime.MemStats
		runtime.ReadMemStats(&mem)
		uptime := "—"
		if !a.startedAt.IsZero() {
			uptime = duration(time.Since(a.startedAt))
		}
		procs := a.processList()
		var procRows []core.Node
		for i, p := range procs {
			proc := p
			detail := proc.Detail
			if proc.PID > 0 {
				detail += " · pid " + fmt.Sprint(proc.PID)
			}
			if proc.Stderr != "" {
				detail += " · " + proc.Stderr
			}
			procRows = append(procRows, setRow(proc.Kind+" · "+proc.Name, detail,
				ui.Text(proc.State, 10.5, ui.Regular, colors.Faint)))
			if i < len(procs)-1 {
				procRows = append(procRows, setDivider())
			}
		}
		if len(procRows) == 0 {
			procRows = append(procRows, setRow("没有运行中的进程", "打开会话或终端后会出现在这里。", nil))
		}
		events := a.diagSnapshot()
		start := max(0, len(events)-60)
		var logRows []core.Node
		for _, ev := range events[start:] {
			color := colors.Muted
			if ev.Level == "error" {
				color = colors.Danger
			} else if ev.Level == "warn" {
				color = colors.Warn
			}
			logRows = append(logRows, core.Text{Content: ev.Time.Format("15:04:05") + "  " + ev.Text, MaxLines: 2,
				Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5, LineHeight: 14}, StyleFunc: ui.Colored(color)})
		}
		if len(logRows) == 0 {
			logRows = append(logRows, core.Text{Content: apptext.T("还没有日志。"), Style: core.Style{FontSize: 10.5},
				StyleFunc: ui.Colored(colors.Faint)})
		}
		var crashRows []core.Node
		if path, at, ok := crashlog.Latest(a.dataDir); ok {
			crashRows = append(crashRows,
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
		} else {
			crashRows = append(crashRows, setRow("崩溃日志", "还没有崩溃记录；panic 时自动写到数据目录的 crashes/。", nil))
		}
		return core.Scroll{TestID: "settings-page", Ref: a.settingsScroll, OnScroll: a.settingsScrolled, Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.Edges{Top: 6, Bottom: 20, Right: 2}, Gap: 4}, Children: []core.Node{
				setGroup("运行",
					setRow("版本", fmt.Sprintf("%s · %s/%s · Go %s", appinfo.Version, runtime.GOOS, runtime.GOARCH, runtime.Version()), nil),
					setDivider(),
					setRow("内存与协程", apptext.T("堆 %.1f MB · %d 个 goroutine · 已运行 %s",
						float64(mem.HeapAlloc)/(1<<20), runtime.NumGoroutine(), uptime), nil),
				),
				setGroup("崩溃", crashRows...),
				a.trajectorySetting(),
				setGroup("进程", procRows...),
				setGroup("最近日志", core.View{Style: core.Style{Gap: 2, Padding: core.Symmetric(4, 2)}, Children: logRows}),
				core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6, Margin: core.Edges{Top: 2}}, Children: []core.Node{
					ui.Button{Text: apptext.T("复制诊断信息"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "diag-copy",
						OnPress: func() { a.copyText(a.diagnosticText(), "诊断信息") }},
					ui.Button{Text: apptext.T("导出诊断包"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "diag-bundle",
						OnPress: a.exportDiagnostics},
					ui.Button{Text: apptext.T("打开日志目录"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
						if dir := a.diagDir(); dir != "" {
							a.cx.OpenURL(fileURL(dir), nil)
						}
					}},
					ui.Button{Text: apptext.T("清空内存日志"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() {
						a.clearDiag()
						a.toast(ui.ToastInfo, "内存日志已清空", "日志文件仍在数据目录的 logs 下。")
					}},
				}},
			}},
		}}
	})
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
