//go:build !js && !android && !ios

package workbench

// PiDeck's standalone pi extensions, installed beside the ask extension.
// Each one is loaded with -e; a name pi already loads is skipped so the
// user's or PiDeck's copy stays the only registration.

import (
	"os"
	"path/filepath"

	"example.com/pideck/extensions"
)

// PiDeck marks pi's process when it injects proxy variables, and its
// shell-proxy extension clears them for agent shell commands only.
const (
	piProxyScopeEnv       = "PIDECK_PI_PROXY_SCOPE"
	piProxyScopeModelOnly = "model-only"
)

// bundledExtensionFile is a module an extension imports, written next to it
// but never passed to pi on its own.
type bundledExtensionFile struct {
	Name    string
	Content []byte
}

// bundledExtension is one file pi loads, plus any sibling modules it needs.
type bundledExtension struct {
	Name    string
	Content []byte
	Modules []bundledExtensionFile
}

// bundledExtensionPaths is where this run installed each injected file.
var bundledExtensionPaths []string

// bundledExtensions is the set this build ships. ask/local-tools/retry are
// installed separately because startPi uses their paths directly.
func bundledExtensions() []bundledExtension {
	return []bundledExtension{
		{Name: "pi-deck-nul-redirect-fix.ts", Content: extensions.NulRedirectFix},
		{Name: "pi-deck-trash-guard.ts", Content: extensions.TrashGuard},
		{Name: "pi-deck-request-size-recovery.ts", Content: extensions.RequestSizeRecovery},
		{Name: "pi-deck-session-title.ts", Content: extensions.SessionTitle},
		{Name: "pi-deck-runtime.ts", Content: extensions.Runtime},
		{Name: "pi-deck-model-options.ts", Content: extensions.ModelOptions},
		{Name: "pi-deck-shell-proxy.ts", Content: extensions.ShellProxy},
		{Name: "pi-deck-plan-mode.ts", Content: extensions.PlanMode},
		{Name: "pi-deck-security-gate.ts", Content: extensions.SecurityGate},
		{Name: "pi-deck-todo.ts", Content: extensions.Todo,
			Modules: []bundledExtensionFile{{Name: "pi-deck-todo-state.ts", Content: extensions.TodoState}}},
	}
}

// installBundledExtensions writes the set under dir and records the paths
// startPi should inject. Extensions pi already loads are left untouched.
func installBundledExtensions(dir string) {
	bundledExtensionPaths = nil
	if dir == "" {
		return
	}
	for _, ext := range bundledExtensions() {
		path := installBundledExtension(dir, ext.Name, ext.Content)
		if path == "" {
			continue
		}
		for _, mod := range ext.Modules {
			writeBundledExtension(dir, mod.Name, mod.Content)
		}
		bundledExtensionPaths = append(bundledExtensionPaths, path)
	}
}

// bundledExtensionArgs is the -e list for this run's installed extensions.
func bundledExtensionArgs() []string {
	args := make([]string, 0, len(bundledExtensionPaths)*2)
	for _, path := range bundledExtensionPaths {
		if path := extensionToInject(path); path != "" {
			args = append(args, "-e", path)
		}
	}
	return args
}

// hasBundledExtension reports whether pi will load this file: our copy in
// the app's data folder, or a copy pi already discovers itself.
func (a *app) hasBundledExtension(name string) bool {
	if a != nil && a.dataDir != "" {
		if _, err := os.Stat(filepath.Join(a.dataDir, "extensions", name)); err == nil {
			return true
		}
	}
	return piLoadsExtension(name)
}
