//go:build !js && !android && !ios

package workbench

import (
	"strings"
	"testing"
	"time"

	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

func TestTaskRunHistoryKeepsFailureReadable(t *testing.T) {
	const prefix = "启动失败：未能创建会话，请检查后端程序和启动参数。\n"
	detail := prefix + strings.Repeat("诊断信息需要完整保留，以便排查连接与本地配置。", 8) +
		"\nexit status 1; request_id=" + strings.Repeat("0123456789abcdef", 12)
	for _, tt := range []struct {
		name          string
		width, height core.Points
		dark          bool
	}{
		{name: "regular", width: 1080, height: 720},
		{name: "compact", width: 600, height: 520},
		{name: "narrow-dark", width: 420, height: 520, dark: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
				cx.SetTheme(viewkit.Theme())
				if tt.dark {
					cx.SetAppearance(core.AppearanceDark)
				} else {
					cx.SetAppearance(core.AppearanceLight)
				}
				started := time.Date(2026, time.November, 26, 9, 0, 0, 0, time.Local)
				a := &app{
					cx: cx, taskRev: core.NewSignal(cx, 0), langRev: core.NewSignal(cx, 0),
					tasks: []*scheduledTask{
						{ID: "review", Name: "每日产品巡检与界面优化", Backend: "pi", Cron: "0 9 * * *"},
						{ID: "summary", Name: "生成工作总结", Backend: "pi", Cron: "0 18 * * *"},
					},
					taskRuns: []taskRun{
						{ID: "failed", TaskID: "review", TaskName: "每日产品巡检与界面优化", Status: taskFailed,
							StartedAt: started, Error: detail},
						{ID: "ok", TaskID: "summary", TaskName: "生成工作总结", Status: taskOK,
							StartedAt: started.Add(-time.Hour), SessionID: "summary-session"},
					},
				}
				return core.View{Style: ui.FillRest.Merge(core.Style{FontFamily: cx.Theme().Sans}),
					StyleFunc: func() core.Style { return core.Style{Background: ui.ColorsOf(cx).Background()} },
					Children:  []core.Node{a.tasksPane()}}
			}, nsgotest.Size(tt.width, tt.height), nsgotest.Environment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop}))
			screen.WaitFor("id:task-run-row-failed", 5*time.Second)
			if nsgotest.Target() != "" {
				screen.Screenshot("task-history-" + tt.name)
			}
			errorView := screen.Find("text:" + detail)
			if height := errorView.Bounds().Size.Height; height < 34 {
				t.Fatalf("failure is confined to one line: height=%v", height)
			}
			history := screen.Find("id:task-run-history")
			if history.Content.Width > history.Bounds().Size.Width+1 {
				t.Fatalf("history overflows horizontally: content=%v viewport=%v", history.Content, history.Bounds())
			}
			if screen.Exists("id:task-run-open-failed") {
				t.Fatal("a failure without a session must remain readable without an open-session action")
			}
			if screen.Exists("id:task-run-copy-ok") {
				t.Fatal("a successful run without an error must not offer copying an error")
			}
			screen.Press("id:task-run-copy-failed")
			if screen.Clipboard != detail {
				t.Fatalf("copied failure = %q, want full original %q", screen.Clipboard, detail)
			}
			screen.Clipboard = ""
			screen.Focus("id:task-run-copy-failed")
			screen.Key("Return")
			if screen.Clipboard != detail {
				t.Fatalf("keyboard copied failure = %q, want full original %q", screen.Clipboard, detail)
			}
			screen.Scroll("id:task-run-history", history.Content.Height)
			open := screen.Find("id:task-run-open-ok").Bounds()
			viewport := screen.Find("id:task-run-history").Bounds()
			if open.Origin.Y < viewport.Origin.Y || open.Origin.Y+open.Size.Height > viewport.Origin.Y+viewport.Size.Height+1 {
				t.Fatalf("next run cannot be reached by scrolling: open=%v viewport=%v", open, viewport)
			}
			if nsgotest.Target() != "" {
				screen.Screenshot("task-history-" + tt.name + "-scrolled")
			}
		})
	}
}
