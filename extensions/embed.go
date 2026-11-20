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

//go:embed pi-deck-local-tools.ts
var LocalTools []byte

//go:embed pi-deck-retry-no-body.ts
var RetryNoBody []byte
