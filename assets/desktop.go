//go:build !js && !android && !ios

package assets

import (
	_ "embed"
)

// StarterPrompts seeds the desktop's prompt library.
//
//go:embed prompts/starter.json
var StarterPrompts []byte
