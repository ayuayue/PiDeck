//go:build !js && !android && !ios

package workbench

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

func TestWechatBindingLivesInSessionMenu(t *testing.T) {
	a, screen, active := startSessionLifecycleApp(t)
	screen.WaitUntil(5*time.Second, func() bool { return a.wechat.ready.GetUntracked() })
	var background *session
	onNativeUI(t, screen, a, func() {
		a.wechat.connection = wechatConnection{Version: 1, Base: wechatBase, Token: "fixture", Owner: "owner"}
		a.wechat.linked.Set(true)
		a.trustProject(a.activeWorkspace())
		background = a.blankSession("wechat-background", a.activeWorkspace(), "微信测试会话")
		a.addTab(background.ID)
	})
	screen.WaitUntil(5*time.Second, func() bool { return len(screen.Query("id:tab")) == 2 })
	screen.RightClick("id:tab >> nth=1")
	screen.WaitFor("id:session-wechat-menu", 5*time.Second)
	screen.Press("id:session-wechat-menu")
	screen.WaitFor("id:wechat-bind", 5*time.Second)
	if nsgotest.Target() != "" {
		shot(screen, "integrations/wechat-session-menu")
	}
	screen.Press("id:wechat-bind")
	screen.WaitUntil(5*time.Second, func() bool { return a.wechat.connection.Session == background.ID })
	if a.activeID.GetUntracked() != active.ID {
		t.Fatal("binding the background session changed the active session")
	}
	wechatWrites.Wait()
	if stored := readWechat(filepath.Join(a.st.dir, "wechat", "connection.yaml")); stored.Session != background.ID {
		t.Fatalf("binding was not persisted: session=%q", stored.Session)
	}
}

func TestWechatSettingsHasNoSessionBinding(t *testing.T) {
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	t.Setenv("PIDECK_V2_LANG", "zh-CN")
	var a *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newApp(cx)
		return core.View{Style: ui.FillRest, Children: []core.Node{a.wechatSettings()}}
	}, nsgotest.Size(760, 600))
	t.Cleanup(a.closeDiag)
	screen.WaitFor("id:wechat-login", 5*time.Second)
	if len(screen.Query("id:wechat-bind")) != 0 {
		t.Fatal("settings still offers session binding")
	}
	if nsgotest.Target() != "" {
		shot(screen, "integrations/wechat-settings")
	}
}
