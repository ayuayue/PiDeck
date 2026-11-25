package client

// Checks the page address a browser reload, a bookmark or a shared link
// carries: the route it names, the address written back for it, and the label
// the tab shows.

import "testing"

func TestParseWebRoute(t *testing.T) {
	cases := map[string]webRoute{
		"http://10.0.2.2:8787/#/session/abc":            {Session: "abc"},
		"http://10.0.2.2:8787/#/session/2026-01-02_x-y": {Session: "2026-01-02_x-y"},
		// The token is read from the query and never becomes part of a
		// route: the address is cleaned of it before it is written back.
		"http://10.0.2.2:8787/?token=secret#/session/abc": {Session: "abc"},
		"http://10.0.2.2:8787/":                           {},
		"http://10.0.2.2:8787/#/":                         {},
		"http://10.0.2.2:8787/#/settings":                 {},
		"http://10.0.2.2:8787/#/session/":                 {},
		"http://10.0.2.2:8787/#/session/   ":              {},
		// A fragment that is not a valid escape names nothing, rather than
		// an id no session has.
		"http://10.0.2.2:8787/#/session/%zz": {},
	}
	for address, want := range cases {
		if got := parseWebRoute(address); got != want {
			t.Errorf("parseWebRoute(%q) = %+v, want %+v", address, got, want)
		}
	}
}

// TestWebRouteRoundTrip keeps the address a reader copies usable: what the
// app writes is what it reads back, ids needing an escape included.
func TestWebRouteRoundTrip(t *testing.T) {
	for _, id := range []string{"s1", "2026-01-02T03-04-05-000Z_remote-1", "带中文的会话", "a b/c?d#e"} {
		route := webRoute{Session: id}
		if got := parseWebRoute(route.hash()); got != route {
			t.Fatalf("route %q round-tripped to %+v", id, got)
		}
	}
	if got := (webRoute{}).hash(); got != "#/" {
		t.Fatalf("the new-session page writes %q, want %q", got, "#/")
	}
}

func TestWebPageTitle(t *testing.T) {
	cases := []struct {
		connected bool
		session   string
		want      string
	}{
		{false, "", "PiDeck V2"},
		{true, "", "PiDeck V2"},
		{true, "   ", "PiDeck V2"},
		{true, "修一下导入", "修一下导入 · PiDeck V2"},
		// A session open on a connection that has since dropped keeps the
		// app's name alone: the page is back on the connect screen.
		{false, "修一下导入", "PiDeck V2"},
	}
	for _, tt := range cases {
		if got := webPageTitle(tt.connected, tt.session); got != tt.want {
			t.Errorf("webPageTitle(%v, %q) = %q, want %q", tt.connected, tt.session, got, tt.want)
		}
	}
}
