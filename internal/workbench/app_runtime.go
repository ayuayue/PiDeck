//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"fmt"
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

// retryPending is whether a retry is still writing this session's fork.
func (s *session) retryPending() bool { return s.retrying != nil && s.retrying.Get() }

// retryPendingNow is retryPending without subscribing the caller.
func (s *session) retryPendingNow() bool { return s.retrying != nil && s.retrying.GetUntracked() }

// composerBlocked reports whether a session cannot take a message yet: its
// dropped files are still loading, or a retry is still writing its fork.
func (a *app) composerBlocked(s *session) bool {
	s.status.Get()
	return s.agentStopping || s.historyLoading || s.filesLoading() || s.retryPending()
}

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

// heapReleaseIdle is how much idle heap is worth handing back, and
// heapReleaseShare how much of the heap may stay idle: a full collection
// costs one pause, so it only runs when there is something to return. A heap
// that is mostly idle falls below what the runtime would ever shrink to on
// its own, and a window left open at a few hundred megabytes would otherwise
// keep its peak in Task Manager.
const (
	heapReleaseIdle  = 192 << 20
	heapReleaseShare = 25
	heapReleaseEvery = 2 * time.Minute
)

// heapReleaseDue says whether the heap has enough idle pages to be worth
// handing back now: not while a reply is being written, where the pause
// would show as a dropped frame, and not more often than every
// heapReleaseEvery.
func heapReleaseDue(mem runtime.MemStats, since, every time.Duration, running bool) bool {
	if running || since < every || mem.HeapSys == 0 {
		return false
	}
	return mem.HeapIdle >= heapReleaseIdle && mem.HeapIdle*100/mem.HeapSys >= heapReleaseShare
}

// releaseIdleHeap returns pages the heap no longer needs. Go gives them up on
// its own schedule and slowly, so a window that once held a few gigabytes of
// transcript keeps showing that peak long after it was closed.
func (a *app) releaseIdleHeap(now time.Time) {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	if !heapReleaseDue(mem, now.Sub(a.lastHeapRelease), heapReleaseEvery, a.anyTurnRunning()) {
		return
	}
	a.releaseHeap(func(uint64) {})
}

// releaseMemory hands the heap's idle pages back on the person's word, which
// is safe at any time: it only runs one more collection and returns pages
// nothing refers to. It says what came back so the press has an answer.
func (a *app) releaseMemory() {
	a.releaseHeap(func(freed uint64) {
		if freed == 0 {
			a.toast(ui.ToastInfo, "没有可释放的内存", "堆里没有空闲页；关掉大会话或大文件预览后再试。")
			return
		}
		a.toast(ui.ToastInfo, "已释放内存", fmt.Sprintf(apptext.T("归还了 %.0f MB 给系统。"), float64(freed)/(1<<20)))
	})
}

// releaseHeap runs a full collection off the interface thread and reports how
// much the heap gave back, measured as the drop in committed heap.
func (a *app) releaseHeap(done func(freed uint64)) {
	if a.releasing {
		return
	}
	a.releasing = true
	go func() {
		var before, after runtime.MemStats
		runtime.ReadMemStats(&before)
		debug.FreeOSMemory()
		runtime.ReadMemStats(&after)
		freed := uint64(0)
		if before.Sys > after.Sys {
			freed = before.Sys - after.Sys
		}
		a.cx.Post(func() {
			a.releasing = false
			a.lastHeapRelease = a.cx.Now()
			a.diagRefresh()
			done(freed)
		})
	}()
}

// anyTurnRunning says whether a reply, a retry or an approval is still in
// flight anywhere: a collection then would land mid-stream.
func (a *app) anyTurnRunning() bool {
	for _, s := range a.all {
		switch s.status.GetUntracked() {
		case statusRunning, statusWaiting:
			return true
		}
	}
	return false
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
	a.recordToast(kind, title, detail)
	a.toaster.Show(ui.ToastContent{Type: kind, Title: apptext.T(title), Description: apptext.T(detail), Duration: 4 * time.Second})
}

// toastAction shows one with a button.
func (a *app) toastAction(kind ui.ToastType, title, detail, action string, fn func()) {
	a.recordToast(kind, title, detail)
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
