//go:build webassets && !js && !android && !ios

package webassets

// The browser client's site, embedded so one binary serves both the API and
// the page. Copy the web build into webassets/site/ before a -tags webassets
// build; it is not committed, and app.wasm alone is tens of megabytes.

import (
	"embed"
	"io/fs"
)

//go:embed all:site
var embeddedWebAssets embed.FS

// Files is the site itself, without the directory it is embedded under.
var Files fs.FS = webAssetsRoot(embeddedWebAssets)

func webAssetsRoot(f fs.FS) fs.FS {
	sub, err := fs.Sub(f, "site")
	if err != nil {
		panic(err)
	}
	return sub
}
