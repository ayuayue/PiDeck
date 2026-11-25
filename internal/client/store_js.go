//go:build js

package client

// A browser has no filesystem to write, so the last connection lives in
// localStorage, and the page's own origin is the desktop that served it.

import (
	"errors"
	"syscall/js"

	"github.com/nsgo-dev/nsgo/core"
)

// mobileStoreKey is where localStorage keeps remote.json's content.
const mobileStoreKey = "pideck-v2.remote"

func readMobileStore(*core.Scope) ([]byte, error) {
	v := js.Global().Get("localStorage").Call("getItem", mobileStoreKey)
	if v.Type() != js.TypeString {
		return nil, errors.New("没有保存的连接")
	}
	return []byte(v.String()), nil
}

func writeMobileStore(_ *core.Scope, raw []byte) error {
	js.Global().Get("localStorage").Call("setItem", mobileStoreKey, string(raw))
	return nil
}

// webStart reads what the page handed the app before it rendered: the origin
// the desktop served it from, a ?token= the settings page's connection link
// carries, and the route a reload or a shared link named.
func webStart() webEntry {
	loc := js.Global().Get("location")
	origin := loc.Get("origin")
	if origin.Type() != js.TypeString {
		return webEntry{}
	}
	search := ""
	if s := loc.Get("search"); s.Type() == js.TypeString {
		search = s.String()
	}
	hash := ""
	if h := loc.Get("hash"); h.Type() == js.TypeString {
		hash = h.String()
	}
	entry := webEntry{Server: origin.String(), Route: parseWebRoute(hash)}
	if q := js.Global().Get("URLSearchParams").New(search).Call("get", "token"); q.Type() == js.TypeString {
		entry.Token = q.String()
	}
	return entry
}

// setPageTitle labels the browser tab: its history, its bookmarks and the
// row a reader picks a tab from all read it.
func setPageTitle(title string) {
	if title == "" {
		return
	}
	js.Global().Get("document").Set("title", title)
}

// webReload loads the page the desktop serves now.
func webReload() { js.Global().Get("location").Call("reload") }
