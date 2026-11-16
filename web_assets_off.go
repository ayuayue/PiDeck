//go:build !webassets || js || android || ios

package main

// A default build serves no page: only a -tags webassets build has the site
// to embed (web_assets_on.go).

import "io/fs"

var webAssets fs.FS
