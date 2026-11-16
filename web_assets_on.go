//go:build webassets && !js

package main

// The browser client's site, embedded so one binary serves both the API and
// the page. Copy the web build into webassets/ before a -tags webassets
// build; it is not committed, and app.wasm alone is tens of megabytes.

import (
	"embed"
	"io/fs"
)

//go:embed all:webassets
var embeddedWebAssets embed.FS

// webAssets is the site itself, without the directory it is embedded under.
var webAssets fs.FS = webAssetsRoot(embeddedWebAssets)

func webAssetsRoot(f fs.FS) fs.FS {
	sub, err := fs.Sub(f, "webassets")
	if err != nil {
		panic(err)
	}
	return sub
}
