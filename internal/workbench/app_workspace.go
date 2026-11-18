//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"path/filepath"
	"time"

	"github.com/nsgo-dev/nsgo/core"
)

// workspace is a project folder and its sessions.
type workspace struct {
	Path      string
	Name      string
	Group     string
	Pinned    bool
	Added     time.Time
	ACPPreset string
	// Chat marks the built-in chat folder under the app's data.
	Chat     bool
	Target   target
	Expanded *core.Signal[bool]
	Sessions *core.Signal[[]*session]
	// Pi are pi's own sessions in this folder, and PiOpen whether the
	// group shows.
	Pi     *core.Signal[[]*session]
	PiOpen *core.Signal[bool]
	// PiLoading says pi's history for the folder is being read, and
	// Visible how many of the project's sessions the rail shows, 0 for
	// the first page.
	PiLoading *core.Signal[bool]
	Visible   *core.Signal[int]
	// piLoaded says this folder's own pi sessions have been read, so a
	// project is scanned when it is opened rather than every project at
	// startup.
	piLoaded bool
}

// Project sessions show a page at a time: the first page, then another
// step with each "more".
const (
	projectSessionPage = 10
	projectSessionStep = 40
)

// key identifies a workspace across machines.
func (w *workspace) key() string { return w.Target.key() + "|" + w.Path }

// label is the folder's name, or its last path element.
func (w *workspace) label() string {
	if w.Name != "" {
		return w.Name
	}
	base := filepath.Base(filepath.Clean(w.Path))
	if base == "." || base == string(filepath.Separator) || base == "" {
		return w.Path
	}
	return base
}
