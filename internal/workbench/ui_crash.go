//go:build !js && !android && !ios

package workbench

// The crash screen: what replaces the interface when something under it
// panicked. It writes the crash log once and offers to reload the screen.

import (
	"path/filepath"

	"example.com/pideck-lite/internal/crashlog"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
)

// crashScreen replaces a panicking screen: it logs the panic, shows what
// happened, and can build the screen again.
func (a *app) crashScreen(cx *core.Scope, err error, reset func()) core.Node {
	if err != nil && a.crashShown != err.Error() {
		a.crashShown = err.Error()
		if path, werr := crashlog.WriteReport(a.dataDir, err, nil); werr == nil {
			a.crashPath = path
		}
	}
	return viewkit.CrashScreen(cx, err, reset, a.crashPath,
		func(path string) { a.openEditorFile(filepath.Dir(path), path) },
		func(text string) { a.copyText(text, "错误") })
}
