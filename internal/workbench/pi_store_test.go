//go:build !js && !android && !ios

package workbench

// The extension store's parsers and source rules: `pi list` output, pi.dev
// cards, and what may reach pi's install/remove commands.

import (
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestParsePiListReadsSourcesPathsAndScopes(t *testing.T) {
	raw := `User packages:
  npm:pi-web-access
    C:\Users\me\.pi\agent\npm\node_modules\pi-web-access
  npm:@scope/tool (filtered)
    C:\Users\me\.pi\agent\npm\node_modules\@scope\tool
  F:\pkgs\local

Project packages:
  npm:project-only
    C:\work\.pi\npm\node_modules\project-only
`
	got := parsePiList(raw)
	want := []piPackage{
		{Source: "F:\\pkgs\\local", Scope: "user"},
		{Source: "npm:@scope/tool", Path: `C:\Users\me\.pi\agent\npm\node_modules\@scope\tool`, Scope: "user"},
		{Source: "npm:pi-web-access", Path: `C:\Users\me\.pi\agent\npm\node_modules\pi-web-access`, Scope: "user"},
		{Source: "npm:project-only", Path: `C:\work\.pi\npm\node_modules\project-only`, Scope: "project"},
	}
	if len(got) != len(want) {
		t.Fatalf("parsed %d packages, want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("package %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestParsePiListIgnoresUnrelatedOutput(t *testing.T) {
	if got := parsePiList("warning: something\n"); len(got) != 0 {
		t.Fatalf("parsed %+v from unrelated output", got)
	}
}

func TestValidPiInstallSource(t *testing.T) {
	good := []string{"npm:pi-web-access", "npm:@scope/tool", "npm:a.b-c_d", "git:github.com/alice/alpha-tool"}
	for _, source := range good {
		if !validPiInstallSource(source) {
			t.Fatalf("validPiInstallSource(%q) = false, want true", source)
		}
	}
	bad := []string{"", "npm:", "https://example.com/x", "git:gitlab.com/a/b", "git:github.com/a/b/tree/main", "npm:../escape", "npm:a;rm", "npm:a b"}
	for _, source := range bad {
		if validPiInstallSource(source) {
			t.Fatalf("validPiInstallSource(%q) = true, want false", source)
		}
	}
}

func TestParsePiCatalogHTMLReadsCardsAndTotal(t *testing.T) {
	raw := `<div class="packages-count">1-2 / 5300</div>
<article class="surface-panel content-card" data-package-card="true" data-package-name="alpha-tool" data-package-search="alpha" data-package-types="extension theme" data-package-downloads="12345" data-package-date="1700000000000">
  <h3 class="packages-name"><a href="/packages/alpha-tool">alpha-tool</a></h3>
  <p class="packages-desc">An &amp; tool for &lt;pi&gt;.</p>
  <div class="packages-meta"><span>alice</span><span>1M/mo</span></div>
  <div class="packages-links"><a href="https://www.npmjs.com/package/alpha-tool">npm</a></div>
</article>
<article class="surface-panel content-card" data-package-card="true" data-package-name="beta" data-package-types="" data-package-downloads="7">
  <h3 class="packages-name"><a href="/packages/beta">beta</a></h3>
  <p class="packages-desc">Beta only.</p>
  <div class="packages-meta"><span>bob</span></div>
</article>`

	items, total, pageSize := parsePiCatalogHTML(raw)
	if total != 5300 {
		t.Fatalf("total = %d, want 5300", total)
	}
	if pageSize != 2 {
		t.Fatalf("page size = %d, want 2", pageSize)
	}
	if len(items) != 2 {
		t.Fatalf("parsed %d items, want 2", len(items))
	}
	first := items[0]
	if first.Name != "alpha-tool" || first.Description != "An & tool for <pi>." || first.Author != "alice" {
		t.Fatalf("first item = %+v", first)
	}
	if first.InstallSource != "npm:alpha-tool" || first.PageURL != "https://pi.dev/packages/alpha-tool" {
		t.Fatalf("first item metadata = %+v", first)
	}
	if len(first.Types) != 2 || first.Types[0] != "extension" || first.Types[1] != "theme" {
		t.Fatalf("first types = %v", first.Types)
	}
	if items[1].InstallSource != "" {
		t.Fatalf("beta has no npm link, install source = %q", items[1].InstallSource)
	}
}

func TestParsePiCatalogGitFallback(t *testing.T) {
	raw := `<article data-package-card="true" data-package-name="gamma-tool" data-package-types="">
  <p class="packages-desc">Git only.</p>
  <a href="https://github.com/alice/gamma-tool">GitHub</a>
</article>`
	items, _, _ := parsePiCatalogHTML(raw)
	if len(items) != 1 || items[0].InstallSource != "git:github.com/alice/gamma-tool" {
		t.Fatalf("git fallback item = %+v", items)
	}
}

func TestPiPackageInstalledMatchesSourceAndNPMName(t *testing.T) {
	installed := []piPackage{{Source: "npm:alpha-tool"}, {Source: "npm:@scope/beta"}}
	if !piPackageInstalled(installed, piCatalogItem{Name: "alpha-tool", InstallSource: "npm:alpha-tool"}) {
		t.Fatal("exact source did not match")
	}
	if !piPackageInstalled(installed, piCatalogItem{Name: "beta", InstallSource: "npm:@scope/beta"}) {
		t.Fatal("npm name did not match")
	}
	if piPackageInstalled(installed, piCatalogItem{Name: "gamma", InstallSource: "npm:gamma"}) {
		t.Fatal("uninstalled item matched")
	}
}

func piStoreTestApp(cx *core.Scope) *app {
	a := &app{
		cx:                  cx,
		lifetime:            cx.Context(),
		chatWidthPctSig:     core.NewSignal(cx, 80),
		piStoreOpen:         core.NewSignal(cx, true),
		piStoreQuery:        core.NewSignal(cx, ""),
		piStoreBusy:         core.NewSignal(cx, false),
		piStoreErr:          core.NewSignal(cx, ""),
		piStoreList:         core.NewSignalFunc(cx, []piCatalogItem(nil), nil),
		piStorePage:         core.NewSignal(cx, 1),
		piStoreLast:         core.NewSignal(cx, 1),
		piStoreInstalled:    core.NewSignalFunc(cx, []piPackage(nil), nil),
		piStoreInstalledErr: core.NewSignal(cx, ""),
		piStoreActing:       core.NewSignal(cx, ""),
		piStoreLocal:        core.NewSignal(cx, false),
	}
	a.piStoreList.Set([]piCatalogItem{
		{Name: "new-tool", Description: "A new tool.", Author: "alice", InstallSource: "npm:new-tool", PageURL: "https://pi.dev/packages/new-tool"},
		{Name: "old-tool", Description: "Already here.", Author: "bob", InstallSource: "npm:old-tool", PageURL: "https://pi.dev/packages/old-tool"},
	})
	a.piStoreInstalled.Set([]piPackage{{Source: "npm:old-tool", Path: "C:\\pi\\old-tool"}})
	return a
}

func TestPiStoreDialogShowsInstallAndRemoveStates(t *testing.T) {
	var a *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = piStoreTestApp(cx)
		return a.piExtensionStoreDialog()
	}, nsgotest.Size(1000, 800))
	screen.WaitFor("id:pi-store-row-new-tool", 5*time.Second)
	screen.WaitFor("id:pi-store-install-new-tool", 5*time.Second)
	screen.WaitFor("id:pi-store-row-old-tool", 5*time.Second)
	screen.WaitFor("id:pi-store-installed-npm-old-tool", 5*time.Second)
	screen.WaitFor("id:pi-store-remove-npm-old-tool", 5*time.Second)
	screen.WaitFor("id:pi-store-update-npm-old-tool", 5*time.Second)
	screen.WaitFor("id:pi-store-local", 5*time.Second)
	screen.WaitFor("id:pi-store-update-all", 5*time.Second)
	if len(screen.Query("id:pi-store-install-old-tool")) != 0 {
		t.Fatal("an installed package still offers install")
	}
	if len(screen.Query("text:已安装")) == 0 {
		t.Fatal("no installed badge")
	}
}
