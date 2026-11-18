//go:build !webassets || js || android || ios

package webassets

// A default build serves no page: only a -tags webassets build has the site
// to embed (web_assets_on.go).

import (
	"io/fs"
)

var Files fs.FS
