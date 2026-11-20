//go:build !js && !android && !ios

package workbench

// The ask extension: pi loads it with -e, and its ask_question tool sends
// every question through one ctx.ui.input envelope that the card reads.
// It is PiDeck's extension, kept as it is so both apps ask the same way.

import (
	"os"
	"path/filepath"

	"example.com/pideck-lite/extensions"
)

// askExtensionName is the file pi loads.
const askExtensionName = "pi-deck-ask-question.ts"
const browserExtensionName = "pi-deck-browser-tools.ts"

// askExtensionPath is where this run installed the extension, "" when it
// could not be written; startPi only adds it for local pi.
var askExtensionPath string

// installBrowserToolsExtension writes the browser MCP bridge for local pi.
func installBrowserToolsExtension(dir string) string {
	if dir == "" {
		return ""
	}
	folder := filepath.Join(dir, "extensions")
	path := filepath.Join(folder, browserExtensionName)
	if cur, err := os.ReadFile(path); err == nil && string(cur) == string(extensions.BrowserTools) {
		return path
	}
	if err := os.MkdirAll(folder, 0o755); err != nil {
		return ""
	}
	if err := writeFileAtomic(path, extensions.BrowserTools, 0o644); err != nil {
		return ""
	}
	return path
}

// installAskExtension writes the bundled extension under dir and returns
// its path. A copy already holding what this build ships is left alone.
func installAskExtension(dir string) string {
	if dir == "" {
		return ""
	}
	folder := filepath.Join(dir, "extensions")
	path := filepath.Join(folder, askExtensionName)
	if cur, err := os.ReadFile(path); err == nil && string(cur) == string(extensions.AskQuestion) {
		return path
	}
	if err := os.MkdirAll(folder, 0o755); err != nil {
		return ""
	}
	if err := os.WriteFile(path, extensions.AskQuestion, 0o644); err != nil {
		return ""
	}
	return path
}
