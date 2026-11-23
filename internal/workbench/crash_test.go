//go:build !js && !android && !ios

package workbench

// Checks crash logs: what a report holds, how the newest is found, and
// the screen the error boundary shows.

import (
	"testing"
	"time"

	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestCrashScreenFallback(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	panics := 0
	app := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		return core.Catch{
			Try: func(*core.Scope) core.Node {
				panics++
				if panics == 1 {
					panic("boom")
				}
				return core.Text{Content: "ok"}
			},
			Fallback: func(cx *core.Scope, err error, reset func()) core.Node {
				return viewkit.CrashScreen(cx, err, reset, "", nil, nil)
			},
		}
	}, nsgotest.Size(900, 700))
	app.WaitFor("id:crash-screen", 5*time.Second)
	app.WaitFor("text:界面出了点问题", 5*time.Second)
	app.Press("id:crash-reset")
	app.WaitFor("text:ok", 5*time.Second)
}
