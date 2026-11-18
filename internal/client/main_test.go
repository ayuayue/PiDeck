package client

import (
	"os"
	"testing"
	"time"

	_ "github.com/nsgo-dev/nsgo"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestMain(m *testing.M) {
	os.Setenv("PIDECK_LITE_LANG", "zh-CN")
	nsgotest.Main(m)
}

func waitApp(app *nsgotest.App, selector string, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		app.Settle()
		if len(app.Query(selector)) > 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	app.WaitFor(selector, time.Second)
}

func waitQuiet(app *nsgotest.App, selector string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		app.Settle()
		if len(app.Query(selector)) == 1 {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

func shot(app *nsgotest.App, name string) {
	if nsgotest.Target() != "" {
		app.Screenshot(name)
	}
}
