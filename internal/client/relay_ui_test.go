package client

import (
	"strings"
	"testing"
	"time"

	"example.com/pideck-lite/internal/relaywire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// TestMobileConnectRelayLinkLayout checks that a relay link goes through
// the connect button on a short screen, where the keyboard leaves little
// room: the form must start at the top so the button stays reachable.
func TestMobileConnectRelayLinkLayout(t *testing.T) {
	t.Setenv("PIDECK_LITE_MOBILE", "1")
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	var built *mobileApp
	root := func(cx *core.Scope) core.Node {
		built = newMobileApp(cx)
		return built.view()
	}
	app := nsgotest.Start(t, root, nsgotest.Size(420, 400))

	button := app.WaitFor("id:mobile-connect", 10*time.Second)
	if bottom := button.Frame.Origin.Y + button.Frame.Size.Height; bottom > 400 {
		t.Fatalf("connect button at %+v is below the window", button.Frame)
	}

	link := relaywire.Link{
		Relay:       "ws://127.0.0.1:1/v1/tunnel",
		Env:         strings.Repeat("e", 48),
		Key:         strings.Repeat("k", 48),
		Fingerprint: strings.Repeat("c", 43),
		Token:       strings.Repeat("t", 24),
	}.String()
	app.Type("id:mobile-server", link)
	app.Press("id:mobile-connect")
	app.WaitUntil(10*time.Second, func() bool {
		return strings.Contains(built.err.Get(), "中继")
	})
	if built.busy.Get() {
		t.Fatal("connect stayed busy")
	}
	if built.server.Get() != link {
		t.Fatalf("saved address = %q", built.server.Get())
	}
}
