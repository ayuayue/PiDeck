//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"flag"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/tsx"
	"github.com/nsgo-dev/nsgo/tsx/pkg"
	"github.com/nsgo-dev/nsgo/ui"
)

var updatePluginPreview = flag.Bool("update-plugin-preview", false, "compile and sign the embedded session tools example")

// This is the explicit resource generation command, not a runtime compiler:
// go test ./internal/workbench -run '^TestPluginPreviewBundleCurrent$' -update-plugin-preview
// Only public key and signed package are retained; private keys die here.
func TestPluginPreviewBundleCurrent(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("bundle generation and drift check run on the Go host")
	}
	raw := pluginPreviewBundleJSON
	if *updatePluginPreview {
		root, data := signedNSGoExample(t, "nsgo-session-tools", "App.tsx")
		var err error
		raw, err = json.MarshalIndent(pluginPreviewBundle{Root: pkg.EncodePublicKey(root), Package: data}, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		raw = append(raw, '\n')
		if err := writeFileAtomic("plugin_examples/nsgo-session-tools/preview.bundle.json", raw, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	p, err := verifyPluginPreview(raw)
	if err != nil {
		t.Fatal(err)
	}
	want := verifiedNSGoExample(t, "nsgo-session-tools", "App.tsx")
	if p.Source() != want.Source() || p.App != want.App || !reflect.DeepEqual(p.Capabilities, want.Capabilities) {
		t.Fatal("embedded preview is stale; regenerate with -run '^TestPluginPreviewBundleCurrent$' -update-plugin-preview")
	}
	if !reflect.DeepEqual(p.Capabilities, pkg.Capabilities{Host: []string{"sessions.list"}}) {
		t.Fatalf("preview unexpectedly expanded its capabilities: %+v", p.Capabilities)
	}
}

func TestPluginPreviewRejectsTamperedBundle(t *testing.T) {
	var bundle pluginPreviewBundle
	if err := json.Unmarshal(pluginPreviewBundleJSON, &bundle); err != nil {
		t.Fatal(err)
	}
	bundle.Package[len(bundle.Package)-1] ^= 1
	raw, err := json.Marshal(bundle)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := verifyPluginPreview(raw); err == nil {
		t.Fatal("accepted a tampered embedded package")
	}
	if _, err := verifyPluginPreview([]byte(`{}`)); err == nil {
		t.Fatal("accepted a bundle without a trust root")
	}
}

func TestPluginPreviewSessionsValidatesAndBoundsRequests(t *testing.T) {
	for _, data := range []any{nil, []any{}, map[string]any{}, map[string]any{"limit": "200"},
		map[string]any{"limit": float64(0)}, map[string]any{"limit": float64(201)},
		map[string]any{"limit": 1.5}, map[string]any{"limit": math.NaN()}, map[string]any{"limit": math.Inf(1)},
		map[string]any{"limit": float64(1), "path": "private"}} {
		if _, err := pluginPreviewSessions(data); err == nil {
			t.Errorf("accepted invalid request: %#v", data)
		}
	}
	rows, err := pluginPreviewSessions(map[string]any{"limit": float64(1)})
	if err != nil || len(rows) != 1 || rows[0].Backend != "pi" || rows[0].Messages != 3 {
		t.Fatalf("bounded response=%+v, err=%v", rows, err)
	}
	rows[0].Messages = 100
	all, err := pluginPreviewSessions(map[string]any{"limit": float64(200)})
	if err != nil || len(all) != 3 || all[0].Messages != 3 {
		t.Fatalf("shared mutable example data: %+v, err=%v", all, err)
	}
	raw, err := json.Marshal(all[0])
	if err != nil || string(raw) != `{"backend":"pi","messages":3}` {
		t.Fatalf("unexpected fields crossed the preview channel: %s, err=%v", raw, err)
	}
}

func startPluginPreview(t *testing.T, width core.Points) *nsgotest.App {
	t.Helper()
	return nsgotest.Start(t, func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		return core.Scroll{Style: core.Style{FlexGrow: 1, Background: colors.Background()}, Children: []core.Node{
			core.View{Style: core.Style{Padding: core.All(16)}, Children: []core.Node{pluginPreviewSection()}},
		}}
	}, nsgotest.Size(width, 760))
}

func TestPluginPreviewOpensGrantsRevokesAndReopens(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; native capture has its own test")
	}
	screen := startPluginPreview(t, 760)
	if len(screen.Query("id:session-tools-panel")) != 0 {
		t.Fatal("preview started before the user opened it")
	}
	screen.Press("id:plugin-preview-open")
	screen.WaitUntil(5*time.Second, func() bool {
		return len(screen.Query("text:宿主未授予会话摘要权限")) == 2
	})
	screen.Press("id:plugin-preview-call")
	screen.WaitUntil(5*time.Second, func() bool {
		return screen.Find("id:plugin-preview-function-result").Text == "宿主未授予会话摘要权限"
	})
	screen.Press("id:plugin-preview-grant")
	screen.WaitFor("text:3 个会话 · 6 条消息", 5*time.Second)
	screen.WaitFor("text:会话数：3", 5*time.Second)
	screen.Press("id:session-tools-refresh")
	screen.Press("id:session-tools-badge-refresh")
	screen.Press("id:plugin-preview-call")
	screen.WaitFor("text:函数结果：3 个会话 · 6 条消息", 5*time.Second)
	shot(screen, "plugins/preview-granted")
	screen.Press("id:plugin-preview-grant")
	screen.WaitUntil(5*time.Second, func() bool {
		return len(screen.Query("text:宿主未授予会话摘要权限")) == 2
	})
	if screen.Find("id:session-tools-totals").Text != "暂无统计" ||
		screen.Find("id:plugin-preview-function-result").Text != "" {
		t.Fatalf("revocation retained old data or function result:\n%s", screen.Dump())
	}
	screen.Press("id:plugin-preview-close")
	screen.WaitForGone("id:plugin-preview", 5*time.Second)
	screen.Press("id:plugin-preview-open")
	screen.WaitUntil(5*time.Second, func() bool {
		return len(screen.Query("text:宿主未授予会话摘要权限")) == 2
	})
	if screen.Find("id:session-tools-totals").Text != "暂无统计" {
		t.Fatal("reopened preview inherited a prior grant or state")
	}
}

func TestPluginPreviewHostRechecksLiveGrantAndDisposal(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless")
	}
	p, err := verifyPluginPreview(pluginPreviewBundleJSON)
	if err != nil {
		t.Fatal(err)
	}
	var function *tsx.Plugin
	var loadErr, callErr error
	var scope *core.Scope
	granted, finished := true, false
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		scope = cx.Child()
		function, loadErr = tsx.Load(scope, p, pluginPreviewSandbox(scope, func() bool { return granted }))
		return core.Text{Content: "Host"}
	})
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	screen.Post(func() {
		granted = false // The VM was started with a grant; the handler must recheck it.
		function.Call("readSessionTotals", nil, func(_ any, err error) { finished, callErr = true, err })
	})
	screen.WaitUntil(5*time.Second, func() bool { return finished })
	if core.ErrorCode(callErr) != core.CodeAccessDenied {
		t.Fatalf("revoked live grant produced %v", callErr)
	}
	finished = false
	screen.Post(func() {
		scope.Dispose()
		granted = true
		function.Call("readSessionTotals", nil, func(_ any, err error) { finished, callErr = true, err })
	})
	screen.WaitUntil(5*time.Second, func() bool { return finished })
	if callErr == nil {
		t.Fatal("disposed function runtime ran again")
	}
}

func TestPluginPreviewMissingViewKeepsSiblingUsable(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless")
	}
	p, err := verifyPluginPreview(pluginPreviewBundleJSON)
	if err != nil {
		t.Fatal(err)
	}
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		return core.View{Children: []core.Node{
			pluginPreviewView(cx, p, "MissingPanel", func() bool { return true }),
			pluginPreviewView(cx, p, "SessionBadge", func() bool { return true }),
		}}
	})
	screen.WaitFor("id:plugin-preview-view-error-MissingPanel", 5*time.Second)
	screen.WaitFor("text:会话数：3", 5*time.Second)
	screen.Press("id:session-tools-badge-refresh")
	if screen.Find("id:session-tools-badge-totals").Text != "会话数：3" {
		t.Fatalf("sibling did not survive failure:\n%s", screen.Dump())
	}
}

func TestPluginPreviewLeavingSettingsResetsGrant(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless")
	}
	var visible *core.Signal[bool]
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		visible = core.NewSignal(cx, true)
		return core.Show{When: visible.Get, Then: func(*core.Scope) core.Node { return pluginPreviewSection() }}
	}, nsgotest.Size(760, 760))
	screen.Press("id:plugin-preview-open")
	screen.WaitFor("id:session-tools-panel", 5*time.Second)
	screen.Press("id:plugin-preview-grant")
	screen.WaitFor("text:3 个会话 · 6 条消息", 5*time.Second)
	screen.Post(func() { visible.Set(false) })
	screen.WaitForGone("id:session-tools-panel", 5*time.Second)
	screen.Post(func() { visible.Set(true) })
	screen.WaitFor("id:plugin-preview-open", 5*time.Second)
	if len(screen.Query("id:plugin-preview")) != 0 {
		t.Fatal("navigating back automatically reopened the preview")
	}
	screen.Press("id:plugin-preview-open")
	screen.WaitUntil(5*time.Second, func() bool {
		return len(screen.Query("text:宿主未授予会话摘要权限")) == 2
	})
}

func TestPluginPreviewDisposedFunctionDropsLateReply(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless")
	}
	p, err := verifyPluginPreview(pluginPreviewBundleJSON)
	if err != nil {
		t.Fatal(err)
	}
	var state *pluginPreviewFunctionState
	var pending *core.HostCall
	var loadErr error
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		scope := cx.Child()
		sandbox := pluginPreviewSandbox(scope, func() bool { return true })
		sandbox.Host.Handle("sessions.list", func(call *core.HostCall) { pending = call })
		state = &pluginPreviewFunctionState{cx: scope, busy: core.NewSignal(scope, false), status: core.NewSignal(scope, "")}
		state.function, loadErr = tsx.Load(scope, p, sandbox)
		if loadErr == nil {
			state.call()
		}
		return core.Text{Content: "Host"}
	})
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	screen.WaitUntil(5*time.Second, func() bool { return pending != nil })
	screen.Post(func() { state.cx.Dispose() })
	screen.Post(func() {
		pending.Resolve([]pluginPreviewSession{{Backend: "pi", Messages: 99}})
		state.call()
	})
	screen.Settle()
	if state.status.GetUntracked() != "" {
		t.Fatalf("disposed controller published a late function result: %q", state.status.GetUntracked())
	}
}

func TestPluginPreviewUsesTranslatedCopy(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless")
	}
	apptext.SetLanguage(apptext.LangEnUS)
	t.Cleanup(func() { apptext.SetLanguage(apptext.LangZhCN) })
	screen := startPluginPreview(t, 760)
	screen.Press("id:plugin-preview-open")
	screen.WaitFor("id:session-tools-panel", 5*time.Second)
	screen.Press("id:plugin-preview-grant")
	screen.WaitFor("text:3 sessions · 6 messages", 5*time.Second)
	screen.Press("id:plugin-preview-call")
	screen.WaitFor("text:Function result: 3 sessions · 6 messages", 5*time.Second)
	if strings.Contains(screen.Dump(), "刷新统计") {
		t.Fatal("the embedded view ignored host translations")
	}
}

func TestNativePluginPreviewScreens(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native screenshot fixture")
	}
	screen := startPluginPreview(t, 720)
	screen.Press("id:plugin-preview-open")
	screen.WaitFor("id:session-tools-panel", 5*time.Second)
	shot(screen, "plugins/preview-denied")
	screen.Press("id:plugin-preview-grant")
	screen.WaitFor("text:3 个会话 · 6 条消息", 5*time.Second)
	screen.Press("id:plugin-preview-call")
	screen.WaitFor("text:函数结果：3 个会话 · 6 条消息", 5*time.Second)
	shot(screen, "plugins/preview-granted")
	screen.Resize(440, 760)
	shot(screen, "plugins/preview-narrow")
	screen.Press("id:plugin-preview-close")
	screen.WaitForGone("id:session-tools-panel", 5*time.Second)
}
