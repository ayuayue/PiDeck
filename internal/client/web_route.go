package client

// The page's address, as the browser build reads and writes it. A browser
// reload, a bookmark and a link pasted into a chat all go through the
// address, so an open session lives there: the hash names it, which keeps
// the address shareable without asking the desktop for any route of its own.

import (
	"net/url"
	"strings"
)

// webRouteSessionPrefix is the hash the app writes for an open session.
const webRouteSessionPrefix = "#/session/"

// webRoute is the state a page address names.
type webRoute struct {
	// Session is the open session's id, "" for the new-session page.
	Session string
}

// webEntry is what the page handed the app before it rendered: the origin
// that served it, the token a connection link carried, and the route a
// reload or a shared link named. A native build gets the zero value.
type webEntry struct {
	Server string
	Token  string
	Route  webRoute
}

// parseWebRoute reads an address the browser navigated to. Anything it does
// not recognise is the new-session page: a stale bookmark and a hand-edited
// hash both land somewhere usable instead of an error.
func parseWebRoute(address string) webRoute {
	_, hash, _ := strings.Cut(address, "#")
	escaped, ok := strings.CutPrefix(hash, "/session/")
	if !ok {
		return webRoute{}
	}
	// An id is a file name on the desktop, so it may hold characters a
	// fragment treats specially; a broken escape is not an id.
	id, err := url.PathUnescape(escaped)
	if err != nil || strings.TrimSpace(id) == "" {
		return webRoute{}
	}
	return webRoute{Session: id}
}

// hash is the address the app writes for this route.
func (r webRoute) hash() string {
	if r.Session == "" {
		return "#/"
	}
	return webRouteSessionPrefix + url.PathEscape(r.Session)
}

// webPageTitle is the browser tab's label: the open session, so a reader
// with several tabs can tell them apart, and the app's name alone otherwise.
func webPageTitle(connected bool, session string) string {
	session = strings.TrimSpace(session)
	if !connected || session == "" {
		return "PiDeck V2"
	}
	return session + " · PiDeck V2"
}
