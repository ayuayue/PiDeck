//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestOverviewKeepsContentClearOfScrollbar(t *testing.T) {
	for _, width := range []core.Points{260, 420} {
		t.Run(fmt.Sprint(width), func(t *testing.T) {
			t.Setenv("PIDECK_V2_HOME", t.TempDir())
			t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
			t.Setenv("PIDECK_V2_LANG", "zh-CN")
			project := t.TempDir()
			var a *app
			screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
				a = newApp(cx)
				s := a.makeSession(sessionMeta{ID: "overview-gutter", Cwd: project,
					Title: strings.Repeat("检查右侧概览的长标题与路径布局", 4)}, localTarget)
				s.File = filepath.Join(project, ".pi", "sessions", "overview-gutter.jsonl")
				s.loaded.Set(true)
				s.readySig.Set(true)
				s.toggleOpen("overview:session")
				a.activeID.Set(s.ID)
				return a.drawerOverview()
			}, nsgotest.Size(width, 220))
			t.Cleanup(a.closeDiag)
			screen.WaitFor("id:overview-scroll", 5*time.Second)
			viewport := screen.Find("id:overview-scroll").Bounds()
			content := screen.FindMounted("id:overview-content").Bounds()
			if content.Size.Height <= viewport.Size.Height {
				t.Fatalf("fixture does not overflow: content=%+v viewport=%+v", content, viewport)
			}
			for _, id := range []string{"overview-rename", "overview-ws-copy", "overview-file-copy", "overview-copy-id", "overview-fav-model"} {
				bounds := screen.FindMounted("id:" + id).Bounds()
				gap := viewport.Origin.X + viewport.Size.Width - bounds.Origin.X - bounds.Size.Width
				if gap < viewkit.PanelInset-0.5 {
					t.Errorf("%s leaves %.1f points for the scrollbar, want at least %v", id, gap, viewkit.PanelInset)
				}
			}
		})
	}
}
