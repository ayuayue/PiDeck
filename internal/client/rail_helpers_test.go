package client

// End-to-end checks that drive a real pi process through the app.

import (
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

// openPhoneRail opens the project rail on a phone: the sessions live in
// the drawer there, not on the page.
func openPhoneRail(app *nsgotest.App) {
	// A drawer that just closed keeps its backdrop over the page for its
	// slide-out; let that finish, or the press lands on the backdrop.
	app.Advance(300 * time.Millisecond)
	app.Press("id:mobile-drawer")
}
