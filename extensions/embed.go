//go:build !js && !android && !ios

// Package extensions owns the extensions shipped with the workbench.
package extensions

import (
	_ "embed"
)

// AskQuestion is installed into the application's own data directory.
//
//go:embed pi-deck-ask-question.ts
var AskQuestion []byte

//go:embed pi-deck-browser-tools.ts
var BrowserTools []byte
