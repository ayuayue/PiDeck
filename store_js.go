//go:build js

package main

// A browser has no filesystem to write, so the last connection lives in
// localStorage, and the page's own origin is the desktop that served it.

import (
	"errors"
	"syscall/js"

	"github.com/nsgo-dev/nsgo/core"
)

// mobileStoreKey is where localStorage keeps remote.json's content.
const mobileStoreKey = "pideck-lite.remote"

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

// webStart reads the origin the desktop served the page from and a
// ?token= the settings page's connection link carries.
func webStart() (server, token string) {
	loc := js.Global().Get("location")
	origin := loc.Get("origin")
	if origin.Type() != js.TypeString {
		return "", ""
	}
	if q := js.Global().Get("URLSearchParams").New(loc.Get("search")).Call("get", "token"); q.Type() == js.TypeString {
		token = q.String()
	}
	return origin.String(), token
}
