//go:build !js && !android && !ios

// Package extensions owns the extensions shipped with the workbench.
//
// Most files are PiDeck's own pi extensions, vendored from
// github.com/ayuayue/PiDeck at 1d4ff3541eedfd8727d4dc7db51daae268d7dbf4
// (resources/extensions). Keep their comments and behavior unchanged so both
// apps load the same extension; local edits would fork the protocol.
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

// The files below are PiDeck's built-in extensions that stand on their own
// without PiDeck's host services.
//
//go:embed pi-deck-nul-redirect-fix.ts
var NulRedirectFix []byte

//go:embed pi-deck-trash-guard.ts
var TrashGuard []byte

//go:embed pi-deck-request-size-recovery.ts
var RequestSizeRecovery []byte

//go:embed pi-deck-session-title.ts
var SessionTitle []byte

//go:embed pi-deck-todo.ts
var Todo []byte

//go:embed pi-deck-todo-state.ts
var TodoState []byte

//go:embed pi-deck-runtime.ts
var Runtime []byte

//go:embed pi-deck-model-options.ts
var ModelOptions []byte

//go:embed pi-deck-shell-proxy.ts
var ShellProxy []byte

//go:embed pi-deck-plan-mode.ts
var PlanMode []byte

//go:embed pi-deck-security-gate.ts
var SecurityGate []byte
