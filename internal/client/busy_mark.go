package client

// The header's activity mark. The page reads from the desktop on its own
// every second or two; most of those reads land in tens of milliseconds, so a
// spinner that followed every one of them would twitch at the top of the page
// without ever explaining anything. This one appears only once a read has
// taken long enough to be worth explaining, and goes when it finishes.

import (
	"time"

	"github.com/nsgo-dev/nsgo/core"
)

// busyMarkDelay is how long a read may take before the page says so.
const busyMarkDelay = 400 * time.Millisecond

// watchBusy turns a slow read into the header's mark. A read that ends
// before the delay shows nothing at all.
func (a *mobileApp) watchBusy(cx *core.Scope) {
	var stop func() bool
	cx.Effect(func() {
		busy := a.transcriptBusy.Get() || a.refreshing.Get()
		// The previous read either ended or is still running under another
		// mark; take its timer back before deciding about this one.
		if stop != nil {
			stop()
			stop = nil
		}
		if !busy {
			a.busyMark.Set(false)
			return
		}
		stop = cx.AfterFunc(busyMarkDelay, func() { a.busyMark.Set(true) })
	})
}
