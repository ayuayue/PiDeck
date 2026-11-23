//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestRailActivityTracksApprovalsAndRunningSessions(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; native runs verify pixels")
	}
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	var waiting, running *session
	var a *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newApp(cx)
		// Every signal a real project carries: the startup scan writes pi's
		// history and its loading flag as soon as it lands.
		ws := &workspace{Path: t.TempDir(), Expanded: core.NewSignal(cx, true), Sessions: core.NewSignalFunc(cx, []*session(nil), nil),
			Pi: core.NewSignalFunc(cx, []*session(nil), nil), PiOpen: core.NewSignal(cx, true),
			PiLoading: core.NewSignal(cx, false), Visible: core.NewSignal(cx, 0)}
		a.workspaces.Set([]*workspace{ws})
		waiting = a.blankSession("waiting", ws, "需要审批的会话")
		waiting.askPending.Set(1)
		running = a.blankSession("running", ws, "正在执行的会话")
		running.runningSig.Set(true)
		ws.Sessions.Set([]*session{waiting, running})
		return a.railActivity()
	}, nsgotest.Size(900, 600))
	screen.WaitFor("id:activity-waiting-waiting", 10*time.Second)
	screen.WaitFor("id:activity-running-running", 5*time.Second)
	if got := screen.Query("text:需要确认 · 1"); len(got) == 0 {
		t.Fatal("activity header does not count the session waiting for approval")
	}
	screen.Post(func() {
		waiting.askPending.Set(0)
		running.runningSig.Set(false)
	})
	screen.WaitFor("text:目前没有需要处理的对话", 5*time.Second)
}

func TestNativeActivityScreen(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native screenshot fixture")
	}
	home := t.TempDir()
	project := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	t.Setenv("PIDECK_V2_LANG", "zh-CN")
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"scanPi":false,"telemetryEnabled":false,"autoModelCatalog":false,"theme":"light"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var a *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newApp(cx)
		ws := &workspace{Path: project, Expanded: core.NewSignal(cx, true), Sessions: core.NewSignalFunc(cx, []*session(nil), nil),
			Pi: core.NewSignalFunc(cx, []*session(nil), nil), PiOpen: core.NewSignal(cx, true),
			PiLoading: core.NewSignal(cx, false), Visible: core.NewSignal(cx, 0)}
		a.workspaces.Set([]*workspace{ws})
		waiting := a.blankSession("activity-approval", ws, "检查 SSH 保存冲突")
		waiting.askPending.Set(2)
		running := a.blankSession("activity-running", ws, "检查发布构建")
		running.runningSig.Set(true)
		ws.Sessions.Set([]*session{waiting, running})
		a.openRailTab(railTabActivity)
		return a.view()
	}, nsgotest.Size(1120, 760))
	t.Cleanup(a.closeDiag)
	screen.WaitFor("id:activity-list", 10*time.Second)
	screen.WaitFor("id:activity-waiting-activity-approval", 5*time.Second)
	screen.WaitFor("id:activity-running-activity-running", 5*time.Second)
	shot(screen, "supplement/activity-review")
}
