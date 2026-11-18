package client

import (
	"os"
	"runtime"

	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
)

// MobileMode selects the native mobile UI, including desktop previews.
func MobileMode() bool {
	return os.Getenv("PIDECK_LITE_MOBILE") == "1" || runtime.GOOS == "ios" || runtime.GOOS == "android"
}

// Mode selects the remote client on phones, browsers and desktop previews.
func Mode() bool { return MobileMode() || runtime.GOOS == "js" }

func webMode() bool { return runtime.GOOS == "js" }

// Root builds the remote client under its error boundary.
func Root(cx *core.Scope) core.Node {
	a := newMobileApp(cx)
	return core.Catch{Try: func(*core.Scope) core.Node { return a.view() },
		Fallback: func(cx *core.Scope, err error, reset func()) core.Node {
			return viewkit.CrashScreen(cx, err, reset, "", nil, nil)
		}}
}
