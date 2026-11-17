//go:build !js && !android && !ios

package main

// The ask extension: pi loads it with -e, and its ask_question tool sends
// every question through one ctx.ui.input envelope that the card reads.
// It is PiDeck's extension, kept as it is so both apps ask the same way.

import (
	_ "embed"
	"os"
	"path/filepath"
)

//go:embed extensions/pi-deck-ask-question.ts
var askExtensionSource []byte

// askExtensionName is the file pi loads.
const askExtensionName = "pi-deck-ask-question.ts"

// askExtensionPath is where this run installed the extension, "" when it
// could not be written; startPi only adds it for local pi.
var askExtensionPath string

// installAskExtension writes the bundled extension under dir and returns
// its path. A copy already holding what this build ships is left alone.
func installAskExtension(dir string) string {
	if dir == "" {
		return ""
	}
	folder := filepath.Join(dir, "extensions")
	path := filepath.Join(folder, askExtensionName)
	if cur, err := os.ReadFile(path); err == nil && string(cur) == string(askExtensionSource) {
		return path
	}
	if err := os.MkdirAll(folder, 0o755); err != nil {
		return ""
	}
	if err := os.WriteFile(path, askExtensionSource, 0o644); err != nil {
		return ""
	}
	return path
}
