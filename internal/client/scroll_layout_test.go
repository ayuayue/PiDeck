package client

import (
	"fmt"
	"testing"
	"time"

	"example.com/pideck/internal/remotewire"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestMobileCommandsKeepRowsClearOfScrollbar(t *testing.T) {
	for _, width := range []core.Points{320, 480} {
		t.Run(fmt.Sprint(width), func(t *testing.T) {
			screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
				a := &mobileApp{draft: core.NewSignal(cx, "/"), active: core.NewSignal(cx, "scroll-test"), features: newMobileSessionFeatures(cx)}
				var commands []remotewire.Command
				for i := range 24 {
					commands = append(commands, remotewire.Command{Name: fmt.Sprintf("command%02d", i), Description: "A long command description for checking the right edge"})
				}
				a.features.commands.Set(commands)
				a.features.commandLimit.Set(len(commands))
				return a.commandSuggestions(cx)
			}, nsgotest.Size(width, 300))
			screen.WaitFor("id:mobile-commands", 5*time.Second)
			viewport := screen.Find("id:mobile-commands").Bounds()
			rows := screen.QueryMounted("role:button")
			if len(rows) != 24 {
				t.Fatalf("command rows = %d, want 24", len(rows))
			}
			first, last := rows[0].Bounds(), rows[len(rows)-1].Bounds()
			if last.Origin.Y+last.Size.Height-first.Origin.Y <= viewport.Size.Height {
				t.Fatal("fixture does not overflow the command viewport")
			}
			for _, row := range rows {
				bounds := row.Bounds()
				gap := viewport.Origin.X + viewport.Size.Width - bounds.Origin.X - bounds.Size.Width
				if gap < viewkit.PanelInset-0.5 {
					t.Errorf("command row leaves %.1f points for the scrollbar, want at least %v", gap, viewkit.PanelInset)
				}
			}
		})
	}
}
