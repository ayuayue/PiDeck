//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"path"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// activeWorkspace is the workspace the active session belongs to, or the
// last one chosen in the rail.
func (a *app) activeWorkspace() *workspace {
	if ws := a.workspaceByWireKey(a.activeWS.Get()); ws != nil {
		return ws
	}
	if s := a.active(); s != nil {
		if ws := a.workspaceFor(s.Target, s.WS); ws != nil {
			return ws
		}
	}
	if list := a.workspaces.Get(); len(list) > 0 {
		return list[0]
	}
	return nil
}

// activeProjectKey is the active project's key, "" when there is none:
// what a per-project entry is scoped to. It keeps the target prefix older
// entries were stored with.
func (a *app) activeProjectKey() string {
	return trustKey(a.activeWorkspace())
}

// busy reports whether a turn is in flight, including a prompt that was
// accepted but has not started streaming yet.
func (s *session) busy() bool { return s.runningSig.Get() }

// busyNow is busy without subscribing the caller.
func (s *session) busyNow() bool { return s.runningSig.GetUntracked() }

// active returns the session in front, or nil.
func (a *app) active() *session { return a.byID[a.activeID.Get()] }

// workspaceFor finds a workspace of a target by path.
func (a *app) workspaceFor(t target, path string) *workspace {
	path = cleanTargetPath(t, path)
	for _, ws := range a.workspaces.Get() {
		if ws.Target.key() != t.key() {
			continue
		}
		if ws.Path == path || (!t.remote() && samePath(ws.Path, path)) {
			return ws
		}
	}
	return nil
}

// workspaceOf finds a local workspace by path.
func (a *app) workspaceOf(path string) *workspace { return a.workspaceFor(localTarget, path) }

// cleanTargetPath normalises a workspace path for its target: cleaned for
// this machine, kept as typed elsewhere.
func cleanTargetPath(t target, value string) string {
	value = strings.TrimSpace(value)
	if t.remote() {
		if !strings.HasPrefix(value, "/") || strings.ContainsAny(value, "\x00\r\n") {
			return ""
		}
		return path.Clean(value)
	}
	if value == "" {
		return ""
	}
	return filepath.Clean(value)
}

// samePath reports whether two local folder paths name the same folder.
// Windows folds the case of a path wherever it goes through the shell, so
// the same folder turns up as c:\work and C:\Work; elsewhere the two
// spellings are two folders.
func samePath(a, b string) bool {
	if a == b {
		return true
	}
	if runtime.GOOS != "windows" {
		return false
	}
	return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

// pathKey is a folder's identity in a map: cleaned, and case-folded on
// Windows, where a project and the folder a session ran in may be spelled
// in different case.
func pathKey(path string) string {
	p := filepath.Clean(path)
	if runtime.GOOS == "windows" {
		return strings.ToLower(p)
	}
	return p
}

// allSessions lists sessions in sidebar order.
func (a *app) allSessions() []*session {
	var out []*session
	for _, ws := range a.workspaces.Get() {
		out = append(out, ws.Sessions.Get()...)
	}
	return out
}

// tick keeps a clock for elapsed labels, and rereads an open Git panel
// every few seconds.
func (a *app) tick() {
	beats := 0
	var loop func()
	loop = func() {
		beats++
		now := a.cx.Now()
		a.clock.Set(now)
		if beats%4 == 0 && a.drawer.GetUntracked() && a.drawerTab.GetUntracked() == "git" {
			a.git.poll()
		}
		// GitHub is not ours to push from: reread the review pane while it
		// is in front, so a merge or comment made elsewhere shows up.
		if beats%30 == 0 && a.paneVisible() && a.activePaneID() == paneReview {
			a.review.poll()
		}
		if now.Sub(a.lastTray) >= trayIdle {
			a.lastTray = now
			a.updateTray()
		}
		if beats%60 == 0 {
			a.releaseIdleHeap(now)
		}
		// The diagnostics page shows live figures: three seconds between
		// passes keeps them current without redrawing the page on every
		// beat, which would push the reader back to the top.
		if beats%3 == 0 && a.paneVisible() && a.activePaneID() == paneSettings &&
			a.settingsTab.GetUntracked() == "diagnostics" {
			a.diagRefresh()
		}
		// pi writes its sessions into its own store; a pass now and then
		// brings in the ones started in a terminal or another app, which
		// nothing else would ever tell the rail about.
		if beats%piScanEvery == 0 && a.cfg.ScanPi {
			a.rescanPi()
		}
		a.cx.AfterFunc(time.Second, loop)
	}
	a.cx.Post(loop)
}

// heapReleaseIdle is how much collected heap is worth handing back, and
// heapReleaseEvery the least time between releases: a full collection costs
// one pause, so it only runs when there is a lot to return.
const (
	heapReleaseIdle  = 1 << 30
	heapReleaseEvery = 2 * time.Minute
)

// releaseIdleHeap returns pages the heap no longer needs. Go gives them up on
// its own schedule and slowly, so a window that once held a few gigabytes of
// transcript keeps showing that peak long after it was closed.
func (a *app) releaseIdleHeap(now time.Time) {
	if now.Sub(a.lastHeapRelease) < heapReleaseEvery {
		return
	}
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	if mem.HeapIdle < heapReleaseIdle {
		return
	}
	a.lastHeapRelease = now
	// The collection runs here, off the interface thread: the next frame is
	// drawn from the state already published.
	go debug.FreeOSMemory()
}

// animateNextLayout eases the next batch's moves, inserts and deletes,
// unless the user asked for less motion.
func (a *app) animateNextLayout() {
	if a.reduceEffects.GetUntracked() || ui.ReduceMotion(a.cx) {
		return
	}
	a.cx.AnimateLayout(core.LayoutEaseInEaseOutPreset)
}

// toast shows one briefly.
func (a *app) toast(kind ui.ToastType, title, detail string) {
	switch kind {
	case ui.ToastError:
		a.diagf("error", "%s：%s", title, detail)
	case ui.ToastWarning:
		a.diagf("warn", "%s：%s", title, detail)
	}
	a.toaster.Show(ui.ToastContent{Type: kind, Title: apptext.T(title), Description: apptext.T(detail), Duration: 4 * time.Second})
}

// toastAction shows one with a button.
func (a *app) toastAction(kind ui.ToastType, title, detail, action string, fn func()) {
	a.toaster.Show(ui.ToastContent{Type: kind, Title: apptext.T(title), Description: apptext.T(detail), Action: apptext.T(action), OnAction: fn, Duration: 6 * time.Second})
}

// cycleTheme moves system → light → dark → system.
func (a *app) cycleTheme() {
	next := map[string]string{"": "light", "system": "light", "light": "dark", "dark": "system"}[a.theme.GetUntracked()]
	a.theme.Set(next)
	a.applyTheme()
	a.st.edit(func(c *config) { c.Theme = next })
	a.toast(ui.ToastInfo, "外观", map[string]string{"light": "浅色", "dark": "深色", "system": "跟随系统"}[next])
}
