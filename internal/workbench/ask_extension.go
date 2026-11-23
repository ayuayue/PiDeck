//go:build !js && !android && !ios

package workbench

// The ask extension: pi loads it with -e, and its ask_question tool sends
// every question through one ctx.ui.input envelope that the card reads.
// It is PiDeck's extension, kept as it is so both apps ask the same way.

import (
	"os"
	"path/filepath"

	"example.com/pideck-v2/extensions"
)

// askExtensionName is the file pi loads.
const askExtensionName = "pi-deck-ask-question.ts"

// askExtensionPath is where this run installed the extension, "" when it
// could not be written; startPi only adds it for local pi.
var askExtensionPath string
var retryExtensionPath string

// installAskExtension writes the bundled extension under dir and returns
// its path. A copy already holding what this build ships is left alone.
func installAskExtension(dir string) string {
	return installBundledExtension(dir, askExtensionName, extensions.AskQuestion)
}

func installLocalToolsExtension(dir string) string {
	return installBundledExtension(dir, "pi-deck-local-tools.ts", extensions.LocalTools)
}

// installBundledExtension writes the bundled extension under dir and returns
// its path. A copy already holding what this build ships is left alone.
//
// A file pi already loads under the same name wins outright: writing ours and
// passing it with -e would register the same tools twice.
func installBundledExtension(dir, name string, contents []byte) string {
	if dir == "" || piLoadsExtension(name) {
		return ""
	}
	return writeBundledExtension(dir, name, contents)
}

// piLoadsExtension reports whether pi's own extension folder already holds a
// file with this name. Users and PiDeck keep their copies there, and pi loads
// that copy without -e.
func piLoadsExtension(name string) bool {
	dir := extensionsDir()
	if dir == "" || name == "" {
		return false
	}
	info, err := os.Stat(filepath.Join(dir, name))
	return err == nil && !info.IsDir()
}

// extensionToInject is the path to pass with -e, or "" when pi would load a
// same-named file itself. Checked again at spawn time so a copy added while
// the app runs is not registered twice.
func extensionToInject(path string) string {
	if path == "" || piLoadsExtension(filepath.Base(path)) {
		return ""
	}
	return path
}

// writeBundledExtension is the file half of installBundledExtension, also
// used for modules that ride beside an injected extension.
func writeBundledExtension(dir, name string, contents []byte) string {
	folder := filepath.Join(dir, "extensions")
	path := filepath.Join(folder, name)
	if cur, err := os.ReadFile(path); err == nil && string(cur) == string(contents) {
		return path
	}
	if err := os.MkdirAll(folder, 0o755); err != nil {
		return ""
	}
	if err := writeFileAtomic(path, contents, 0o644); err != nil {
		return ""
	}
	return path
}
