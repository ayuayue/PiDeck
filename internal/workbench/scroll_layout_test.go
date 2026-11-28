//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestProjectGroupListKeepsChoicesClearOfScrollbar(t *testing.T) {
	for _, width := range []core.Points{360, 600} {
		t.Run(fmt.Sprint(width), func(t *testing.T) {
			t.Setenv("PIDECK_V2_HOME", t.TempDir())
			t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
			t.Setenv("PIDECK_V2_LANG", "zh-CN")
			project := t.TempDir()
			var a *app
			screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
				a = newApp(cx)
				var projects []*workspace
				for i := range 24 {
					projects = append(projects, &workspace{Path: filepath.Join(project, fmt.Sprintf("project-%02d", i)), Target: localTarget})
				}
				a.workspaces.Set(projects)
				return a.projectGroupCreateDialog(core.NewSignal(cx, true))
			}, nsgotest.Size(width, 700))
			t.Cleanup(a.closeDiag)
			screen.WaitFor("id:project-group-create-list", 5*time.Second)
			viewport := screen.Find("id:project-group-create-list").Bounds()
			screen.Scroll("id:project-group-create-list", 200)
			screen.Settle()
			choices := screen.QueryMounted("role:checkbox")
			if len(choices) == 0 {
				t.Fatal("project list contains no mounted choices")
			}
			for _, choice := range choices {
				bounds := choice.Bounds()
				gap := viewport.Origin.X + viewport.Size.Width - bounds.Origin.X - bounds.Size.Width
				if gap < viewkit.PanelInset-0.5 {
					t.Errorf("project choice leaves %.1f points for the scrollbar, want at least %v", gap, viewkit.PanelInset)
				}
			}
		})
	}
}
