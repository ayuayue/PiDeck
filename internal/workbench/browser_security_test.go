//go:build !js && !android && !ios

package workbench

import (
	"testing"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestBrowserLeaseRequiresVisibleTrustedOwnerAndOrigin(t *testing.T) {
	var a *app
	s := &session{ID: "owner", WS: "project"}
	ws := &workspace{Path: "project"}
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = &app{cx: cx, browser: newBrowserState(cx), byID: map[string]*session{s.ID: s},
			workspaces: core.NewSignalFunc(cx, []*workspace{ws}, nil), activePane: core.NewSignal(cx, paneBrowser)}
		return core.View{}
	}, nsgotest.Size(600, 400))
	defer screen.Settle()
	a.cfg.TrustedProjects = []string{trustKey(ws)}
	a.browser.owner.Set(s.ID)
	a.browser.origin = "https://example.com"
	a.browser.open.Set(true)
	a.browser.nav.Set(core.WebNavigation{URL: "https://example.com/page"})
	if !a.browserReady(s) {
		t.Fatal("explicitly shared trusted page was rejected")
	}
	for _, change := range []func(){
		func() { a.browser.owner.Set("other") },
		func() { a.browser.open.Set(false) },
		func() { a.activePane.Set("") },
		func() { a.cfg.TrustedProjects = nil },
		func() { a.browser.nav.Set(core.WebNavigation{URL: "https://evil.example/page"}) },
		func() { a.browser.nav.Set(core.WebNavigation{URL: "https://example.com/page", Loading: true}) },
		func() { s.deleting = true },
	} {
		change()
		if a.browserReady(s) {
			t.Fatal("revoked or hidden browser page retained its lease")
		}
		a.browser.owner.Set(s.ID)
		a.browser.open.Set(true)
		a.activePane.Set(paneBrowser)
		a.cfg.TrustedProjects = []string{trustKey(ws)}
		a.browser.nav.Set(core.WebNavigation{URL: "https://example.com/page"})
		s.deleting = false
	}
	p := &browserApproval{decision: make(chan bool, 1)}
	a.browser.pending.Set(p)
	a.revokeBrowser()
	if <-p.decision || a.browser.owner.GetUntracked() != "" || a.browser.pending.GetUntracked() != nil {
		t.Fatal("revoking the lease did not reject the pending action")
	}
}
