//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/tsx"
	"github.com/nsgo-dev/nsgo/tsx/pkg"
	_ "github.com/nsgo-dev/nsgo/tsx/ui"
)

func sessionToolsExample(t *testing.T) *pkg.Package {
	t.Helper()
	if nsgotest.Target() != "" {
		t.Skip("headless integration example")
	}
	return verifiedNSGoExample(t, "nsgo-session-tools", "App.tsx")
}

func TestNSGoPluginNamedViewsUseIndependentChannelsAndState(t *testing.T) {
	p := sessionToolsExample(t)
	panel, badge := core.NewHost(), core.NewHost()
	panelCalls, badgeCalls := 0, 0
	panel.Handle("sessions.list", func(c *core.HostCall) {
		panelCalls++
		if !reflect.DeepEqual(c.Data, map[string]any{"limit": float64(200)}) {
			c.Reject(errors.New("unexpected request"))
			return
		}
		c.Resolve([]map[string]any{{"backend": "pi", "messages": panelCalls}, {"backend": "acp", "messages": 4}})
	})
	badge.Handle("sessions.list", func(c *core.HostCall) {
		badgeCalls++
		c.Resolve([]map[string]any{{"backend": "pi", "messages": 0}})
	})
	app := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		return core.View{Children: []core.Node{
			core.Text{Content: "Host", TestID: "session-tools-host"},
			tsx.View{Package: p, Export: "SessionPanel", Props: map[string]any{"title": "会话统计"}, Sandbox: tsx.Sandbox{Host: panel}},
			tsx.View{Package: p, Export: "SessionBadge", Sandbox: tsx.Sandbox{Host: badge}},
		}}
	})
	app.WaitFor("text:2 个会话 · 5 条消息", 5*time.Second)
	app.WaitFor("text:会话数：1", 5*time.Second)
	app.Press("id:session-tools-refresh")
	app.WaitFor("text:2 个会话 · 6 条消息", 5*time.Second)
	if panelCalls != 2 || badgeCalls != 1 || app.Find("id:session-tools-badge-totals").Text != "会话数：1" {
		t.Fatalf("named views shared state or channel: panel=%d badge=%d\n%s", panelCalls, badgeCalls, app.Dump())
	}
	if app.Find("id:session-tools-host").Text != "Host" {
		t.Fatal("the plugin replaced its host's content")
	}
}

func TestNSGoPluginNamedViewRechecksGrantAfterDisable(t *testing.T) {
	p := sessionToolsExample(t)
	var enabled *core.Signal[bool]
	var pending *core.HostCall
	channels, calls := 0, 0
	app := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		enabled = core.NewSignal(cx, true)
		return core.Show{When: enabled.Get, Then: func(cx *core.Scope) core.Node {
			channels++
			channel := core.NewHost()
			channel.Handle("sessions.list", func(c *core.HostCall) { calls++; pending = c })
			grant := &pkg.Capabilities{Host: []string{"sessions.list"}}
			if channels > 1 {
				grant = &pkg.Capabilities{}
			}
			return tsx.View{Package: p, Export: "SessionPanel", Sandbox: tsx.Sandbox{Host: channel, Grant: grant}}
		}}
	})
	app.WaitUntil(5*time.Second, func() bool { return pending != nil })
	app.Post(func() { enabled.Set(false) })
	app.WaitForGone("id:session-tools-panel", 5*time.Second)
	// This answer belongs to the disposed view, even if a new one is opened.
	app.Post(func() {
		enabled.Set(true)
		pending.Resolve([]map[string]any{{"backend": "pi", "messages": 99}})
	})
	app.WaitFor("text:宿主未授予会话摘要权限", 5*time.Second)
	if channels != 2 || calls != 1 || app.Find("id:session-tools-totals").Text != "暂无统计" {
		t.Fatalf("late result or old grant reached the reopened view: channels=%d calls=%d\n%s", channels, calls, app.Dump())
	}
}

func TestNSGoPluginNamedViewFailureKeepsSiblingWorking(t *testing.T) {
	p := sessionToolsExample(t)
	channel := core.NewHost()
	calls := 0
	channel.Handle("sessions.list", func(c *core.HostCall) {
		calls++
		rows := make([]map[string]any, calls)
		for i := range rows {
			rows[i] = map[string]any{"backend": "pi", "messages": 0}
		}
		c.Resolve(rows)
	})
	var failed error
	app := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		return core.View{Children: []core.Node{
			core.Catch{Try: tsx.View{Package: p, Export: "MissingPanel"}.Render,
				Fallback: func(_ *core.Scope, err error, _ func()) core.Node {
					failed = err
					return core.Text{Content: "Unavailable", TestID: "session-tools-failed"}
				}},
			tsx.View{Package: p, Export: "SessionBadge", Sandbox: tsx.Sandbox{Host: channel}},
		}}
	})
	app.WaitFor("text:会话数：1", 5*time.Second)
	app.Press("id:session-tools-badge-refresh")
	app.WaitFor("text:会话数：2", 5*time.Second)
	if !errors.Is(failed, tsx.ErrNoViewExport) || app.Find("id:session-tools-failed").Text != "Unavailable" {
		t.Fatalf("wrong boundary failure: %v\n%s", failed, app.Dump())
	}
}

func TestNSGoPluginSessionFunctionRunsWithoutMountingUI(t *testing.T) {
	p := sessionToolsExample(t)
	channel := core.NewHost()
	channel.Handle("sessions.list", func(c *core.HostCall) {
		c.Resolve([]map[string]any{{"backend": "pi", "messages": 3}, {"backend": "acp", "messages": 2}})
	})
	var result any
	var callErr error
	app := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		plugin, err := tsx.Load(cx, p, tsx.Sandbox{Host: channel})
		if err != nil {
			callErr = err
			return nil
		}
		plugin.Call("readSessionTotals", nil, func(v any, err error) { result, callErr = v, err })
		return core.Text{Content: "Host"}
	})
	app.WaitUntil(5*time.Second, func() bool { return result != nil || callErr != nil })
	raw, encodeErr := json.Marshal(result)
	want := `{"acp":1,"messages":5,"pi":1,"sessions":2}`
	if callErr != nil || encodeErr != nil || string(raw) != want {
		t.Fatalf("function result=%s call err=%v encode err=%v, want %s", raw, callErr, encodeErr, want)
	}
	if len(app.Query("id:session-tools-panel")) != 0 || len(app.Query("id:session-tools-badge")) != 0 {
		t.Fatal("loading a function mounted a view")
	}
}

func TestNSGoPluginSessionFunctionRejectsInvalidHostProjection(t *testing.T) {
	p := sessionToolsExample(t)
	for _, test := range []struct {
		name string
		data any
		want string
	}{
		{"object", map[string]any{}, "一次最多处理"},
		{"too many", make([]any, 201), "一次最多处理"},
		{"null row", []any{nil}, "会话摘要格式无效"},
		{"array row", []any{[]any{}}, "会话摘要格式无效"},
		{"backend", []map[string]any{{"backend": "shell", "messages": 0}}, "后端标识无效"},
		{"negative", []map[string]any{{"backend": "pi", "messages": -1}}, "消息数量无效"},
		{"string", []map[string]any{{"backend": "pi", "messages": "1"}}, "消息数量无效"},
		{"overflow", []map[string]any{{"backend": "pi", "messages": 9007199254740991}, {"backend": "acp", "messages": 1}}, "消息总数超出范围"},
	} {
		t.Run(test.name, func(t *testing.T) {
			channel := core.NewHost()
			channel.Handle("sessions.list", func(c *core.HostCall) { c.Resolve(test.data) })
			var callErr error
			app := nsgotest.Start(t, func(cx *core.Scope) core.Node {
				plugin, err := tsx.Load(cx, p, tsx.Sandbox{Host: channel})
				if err != nil {
					callErr = err
					return nil
				}
				plugin.Call("readSessionTotals", nil, func(_ any, err error) { callErr = err })
				return nil
			})
			app.WaitUntil(5*time.Second, func() bool { return callErr != nil })
			if !strings.Contains(callErr.Error(), test.want) {
				t.Fatalf("err=%v, want %q", callErr, test.want)
			}
		})
	}
}

func TestNSGoPluginSessionFunctionCloseFinishesPendingCallOnce(t *testing.T) {
	p := sessionToolsExample(t)
	channel := core.NewHost()
	var pending *core.HostCall
	calls := 0
	channel.Handle("sessions.list", func(c *core.HostCall) { calls++; pending = c })
	var plugin *tsx.Plugin
	var loadErr, callErr, closedErr error
	finished := 0
	app := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		plugin, loadErr = tsx.Load(cx, p, tsx.Sandbox{Host: channel})
		if loadErr == nil {
			plugin.Call("readSessionTotals", nil, func(_ any, err error) { finished++; callErr = err })
		}
		return nil
	})
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	app.WaitUntil(5*time.Second, func() bool { return pending != nil })
	app.Post(func() { plugin.Close() })
	app.Settle()
	if finished != 1 || callErr == nil {
		t.Fatalf("close left its caller waiting: finished=%d err=%v", finished, callErr)
	}
	app.Post(func() {
		pending.Resolve([]any{})
		plugin.Call("readSessionTotals", nil, func(_ any, err error) { closedErr = err })
	})
	app.Settle()
	if finished != 1 || closedErr == nil || calls != 1 {
		t.Fatalf("closed plugin ran again: finished=%d calls=%d closedErr=%v", finished, calls, closedErr)
	}
}
