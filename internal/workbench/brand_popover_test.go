//go:build !js && !android && !ios

package workbench

import (
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestBrandPopoverKeepsDisclosureOnEnvironmentRefresh(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless environment refresh coverage")
	}
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}, nsgotest.Size(1200, 800), nsgotest.Environment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop}))
	t.Cleanup(built.closeDiag)
	screen.Press("id:rail-brand")
	for _, id := range []string{"brand-check-updates", "brand-releases", "brand-customize", "brand-project", "brand-pi-project", "brand-about"} {
		if !screen.Enabled("id:" + id) {
			t.Fatalf("brand destination %q is unavailable", id)
		}
	}
	screen.Press("id:brand-runtime-toggle")
	screen.Focus("id:brand-runtime-toggle")
	toggleID := screen.Find("id:brand-runtime-toggle").ID
	screen.Post(func() {
		info := built.env.GetUntracked()
		info.Probing, info.PiError, info.PiPath, info.PiVersion = false, "", "pi", "1.6.2"
		built.env.Set(info)
		built.setBrandName(strings.Repeat("工作台", 8))
	})
	screen.Settle()
	if got := screen.Find("id:brand-pi-version").Text; got != "1.6.2" {
		t.Fatalf("runtime version did not refresh: %q", got)
	}
	if got := screen.Find("id:brand-pi-status").Text; got != "pi 1.6.2" {
		t.Fatalf("brand status did not refresh: %q", got)
	}
	if got := screen.Find("id:brand-info-name").Text; got != strings.Repeat("工作台", 8) {
		t.Fatalf("custom brand name did not refresh: %q", got)
	}
	if toggle := screen.Find("id:brand-runtime-toggle"); toggle.ID != toggleID || !toggle.Focused {
		t.Fatal("refresh rebuilt or unfocused the runtime disclosure")
	}
	screen.Press("id:brand-runtime-toggle")
	screen.WaitForGone("id:brand-runtime-details", time.Second)
	screen.Key("escape")
	screen.WaitForGone("id:brand-info", time.Second)
}
