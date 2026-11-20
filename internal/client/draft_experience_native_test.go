package client

import (
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

func TestNativeMobileDraftChangeScreens(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native narrow-window screenshot fixture")
	}
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	t.Setenv("PIDECK_LITE_LANG", "en-US")
	var a *mobileApp
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newMobileApp(cx)
		a.active.Set("draft-source")
		a.draft.Set("Keep the text I typed while waiting.")
		a.offerDraftChange(nil, "draft-source", "previous input", "Review the changes and produce a reproducible release checklist.")
		return core.View{Style: ui.FillRest, Children: []core.Node{core.View{Style: core.Style{FlexGrow: 1}}, a.composer(cx)}}
	}, nsgotest.Size(390, 800))
	screen.WaitFor("id:draft-change-apply", 5*time.Second)
	shot(screen, "v1/mobile-draft-conflict")
	screen.Press("id:draft-change-apply")
	screen.WaitFor("id:draft-change-undo", 5*time.Second)
	shot(screen, "v1/mobile-draft-undo")
}
