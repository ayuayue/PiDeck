//go:build !js && !android && !ios

package workbench

import (
	"example.com/pideck-v2/webassets"
)

// webAssets can be replaced by HTTP tests without changing the embedded files.
var webAssets = webassets.Files
