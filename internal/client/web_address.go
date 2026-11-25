package client

// The page address the browser build keeps in step with the page it shows: a
// session opened or closed writes it, and a browser navigation reads it back.
// A native build has no address bar, so every write here is a no-op there.

import (
	"github.com/nsgo-dev/nsgo/core"
)

// writeWebAddress records a route in the page address. It is the one place
// the app writes one, so the "following the browser" guard lives here: an
// address the browser just navigated to is not written back, which would add
// a history entry for every step back.
func (a *mobileApp) writeWebAddress(route webRoute, push bool) {
	if a.cx == nil || !webMode() || a.applyingRoute {
		return
	}
	options := core.AppURLOptions{History: core.HistoryReplace}
	if push {
		options.History = core.HistoryPush
	}
	// The address must stay on the page's origin; a hash always does. A
	// refused write leaves the previous address, which only costs a reload
	// its place, so it is not worth a message.
	_ = a.cx.SetAppURL(route.hash(), options)
}

// syncWebAddress makes the address name the open session.
func (a *mobileApp) syncWebAddress(push bool) {
	a.writeWebAddress(webRoute{Session: a.active.GetUntracked()}, push)
}

// showWebRoute follows the browser: back, forward, or an address typed into
// the bar. A screen the back handler already closed never reaches here, so
// this only ever applies a navigation nothing else took.
func (a *mobileApp) showWebRoute(route webRoute) {
	if !a.connected.GetUntracked() || route.Session == a.active.GetUntracked() {
		return
	}
	a.applyingRoute = true
	defer func() { a.applyingRoute = false }()
	if route.Session == "" {
		a.closeSession()
		return
	}
	a.openSession(route.Session, a.sessionTitle(route.Session))
}

// resumeWebRoute opens the session a reload or a shared link named. It waits
// for the state that names the session, so the page can label it at once.
func (a *mobileApp) resumeWebRoute() {
	route := a.pendingRoute
	a.pendingRoute = webRoute{}
	if route.Session == "" {
		return
	}
	a.applyingRoute = true
	a.openSession(route.Session, a.sessionTitle(route.Session))
	a.applyingRoute = false
}

// sessionTitle is a session's name in the state the app already holds, "" for
// one the state has not listed: the transcript names it once it arrives.
func (a *mobileApp) sessionTitle(id string) string {
	for _, project := range a.state.GetUntracked().Projects {
		for _, session := range project.Sessions {
			if session.ID == id {
				return session.Title
			}
		}
	}
	return ""
}
