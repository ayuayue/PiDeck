//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

// A local page proves native WebView evaluation and the approval boundary;
// no external page, agent account or paid service participates.
func TestNativeBrowserApprovalRoundTrip(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("requires a native WebView")
	}
	home, project := t.TempDir(), t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", home)
	t.Setenv("PIDECK_LITE_PI_CONFIG", t.TempDir())
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"scanPi":false,"telemetryEnabled":false,"autoModelCatalog":false}`), 0o600); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(`<html><head><title>Local browser fixture</title></head><body><button onclick="this.textContent='Done'">Run</button><input aria-label="Name"></body></html>`))
	}))
	defer srv.Close()
	var a *app
	var s *session
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newApp(cx)
		s = a.makeSession(sessionMeta{ID: "native-browser", Cwd: project, Title: "Browser fixture"}, localTarget)
		a.addWorkspace(project)
		ws := a.workspaceOf(project)
		a.cfg.TrustedProjects = []string{trustKey(ws)}
		a.activeID.Set(s.ID)
		a.activePane.Set(paneBrowser)
		a.browser.open.Set(true)
		a.navigateBrowser(srv.URL + "/")
		return core.View{Style: ui.FillRest, Children: []core.Node{a.browserPane(), a.browserApprovalDialog()}}
	}, nsgotest.Size(1100, 760))
	t.Cleanup(a.closeDiag)
	screen.WaitFor("text:Local browser fixture", 20*time.Second)
	screen.Press("id:browser-share")
	ready := false
	onNativeUI(t, screen, a, func() { ready = a.browserReady(s) })
	if !ready {
		t.Fatal("explicit browser share did not create a lease")
	}
	type evaluated struct {
		raw string
		err error
	}
	evaluate := func(script string) string {
		done := make(chan evaluated, 1)
		a.cx.Post(func() { a.browser.view.Evaluate(script, func(raw string, err error) { done <- evaluated{raw, err} }) })
		var result evaluated
		screen.WaitUntil(10*time.Second, func() bool {
			select {
			case result = <-done:
				return true
			default:
				return false
			}
		})
		if result.err != nil {
			t.Fatal(result.err)
		}
		return result.raw
	}
	var snap browserSnapshot
	if err := json.Unmarshal([]byte(evaluate(browserSnapshotScript(srv.URL+"/"))), &snap); err != nil {
		t.Fatal(err)
	}
	if len(snap.Targets) != 2 || snap.Targets[0].Label != "Run" {
		t.Fatalf("native snapshot=%+v", snap)
	}
	snap.ID = "native-snapshot"
	onNativeUI(t, screen, a, func() { a.browser.last = &snap })
	result := make(chan error, 1)
	go func() { result <- a.browserAct(t.Context(), s, "click", browserAction{Snapshot: snap.ID, Index: 0}) }()
	screen.WaitFor("id:browser-approve", 10*time.Second)
	shot(screen, "supplement/browser-approval")
	if raw := evaluate(`document.querySelector('button').textContent`); raw != `"Run"` {
		t.Fatalf("page changed before approval: %s", raw)
	}
	screen.Press("id:browser-approve")
	var actionErr error
	screen.WaitUntil(10*time.Second, func() bool {
		select {
		case actionErr = <-result:
			return true
		default:
			return false
		}
	})
	if actionErr != nil {
		t.Fatal(actionErr)
	}
	if raw := evaluate(`document.querySelector('button').textContent`); raw != `"Done"` {
		t.Fatalf("approved click did not reach native page: %s", raw)
	}
	shot(screen, "supplement/browser-complete")
}

// Native tests run outside the engine's goroutine. Keep fixture mutations
// on the same owner as real event handlers and wait for their publication.
func onNativeUI(t *testing.T, screen *nsgotest.App, a *app, fn func()) {
	t.Helper()
	done := make(chan struct{})
	a.cx.Post(func() { fn(); close(done) })
	screen.WaitUntil(5*time.Second, func() bool {
		select {
		case <-done:
			return true
		default:
			return false
		}
	})
}
