//go:build !js && !android && !ios

package workbench

// A prewarmed pi process. pi is a Node CLI that reads its config, models
// and extensions before it answers anything, which a new session used to
// pay before its first message was sent. One spare is kept for the project
// the user is working in: a new session adopts it (pi fixes its session id
// at launch, so the id comes with the process) and a fresh spare starts
// for the next one.
//
// A spare is only started when the app has sessions on disk, so a test or
// a first run starts no process nobody asked for, and never when the
// session would need a private tool server: its token is minted per
// session and cannot be handed to a process launched before the session
// exists.

import (
	"time"
)

// piWarmTTL is how long an unused spare is kept: long enough for the pause
// between two sessions, short enough not to hold a Node process forever.
const piWarmTTL = 10 * time.Minute

// warmPi is one booted pi waiting for a session.
type warmPi struct {
	ID      string // the session id pi was launched with
	Dir     string
	Target  target
	C       *piClient
	Started time.Time
}

func piWarmKey(t target, dir string) string { return t.key() + "|" + dir }

// warmEligible says whether a spare may run for this project.
func (a *app) warmEligible(ws *workspace) bool {
	if !a.warmOK || ws == nil || ws.Target.remote() || a.st == nil {
		return false
	}
	// The memory server's token is bound to a session object that does not
	// exist yet, so a process started ahead of one cannot carry it.
	return !a.cfg.MemoryTools && !a.cfg.RecordTrajectory
}

// ensureWarmPi keeps one booted process for the project, replacing a spare
// that belongs to another one.
func (a *app) ensureWarmPi(ws *workspace) {
	if !a.warmEligible(ws) {
		return
	}
	key := piWarmKey(ws.Target, ws.Path)
	a.warmMu.Lock()
	if a.warm != nil && piWarmKey(a.warm.Target, a.warm.Dir) == key {
		a.warmMu.Unlock()
		return
	}
	if a.warmSpawning == key {
		a.warmMu.Unlock()
		return
	}
	old := a.warm
	a.warm = nil
	a.warmSpawning = key
	a.warmMu.Unlock()
	if old != nil {
		go old.C.stop()
		a.diagf("info", "pi 预热进程随项目切换回收")
	}
	id, dir, t := newSessionID(), ws.Path, ws.Target
	sessions, piPath := a.st.sessions, a.piPath()
	started := time.Now()
	go func() {
		// The callbacks are replaced when a session adopts the process;
		// until then an exit only drops the spare.
		c, err := startPi(t, piPath, dir, sessions, id, "",
			func(piEvent) {}, func(uiRequest) {}, func(error) { a.dropWarmPi(id) })
		if err != nil {
			a.finishWarmSpawn(key, nil)
			a.diagf("warn", "pi 预热失败：%v", err)
			return
		}
		// get_state makes pi finish loading models and extensions now
		// instead of when the first message arrives.
		if err := c.call(map[string]any{"type": "get_state"}, nil, 60*time.Second); err != nil {
			c.stop()
			a.finishWarmSpawn(key, nil)
			a.diagf("warn", "pi 预热失败：%v", err)
			return
		}
		w := &warmPi{ID: id, Dir: dir, Target: t, C: c, Started: time.Now()}
		if !a.finishWarmSpawn(key, w) {
			return
		}
		a.diagf("info", "pi 预热就绪 %s（%s）", shortPath(dir, 48), time.Since(started).Round(time.Millisecond))
		a.expireWarmPi(w, piWarmTTL)
	}()
}

// finishWarmSpawn records the spawn's result when nobody else took the
// slot, and ends a process it could not keep.
func (a *app) finishWarmSpawn(key string, w *warmPi) bool {
	a.warmMu.Lock()
	if a.warmSpawning == key {
		a.warmSpawning = ""
	}
	kept := w != nil && a.warm == nil
	if kept {
		a.warm = w
	}
	a.warmMu.Unlock()
	if w != nil && !kept {
		go w.C.stop()
	}
	return kept
}

// takeWarmPi hands the spare to a new session in this project, or reports
// that none is ready. A spare in another project is left for ensureWarmPi
// to replace: pi's working folder is fixed at launch.
func (a *app) takeWarmPi(ws *workspace) *warmPi {
	if ws == nil {
		return nil
	}
	key := piWarmKey(ws.Target, ws.Path)
	a.warmMu.Lock()
	w := a.warm
	if w == nil || piWarmKey(w.Target, w.Dir) != key || w.C.isClosed() {
		a.warmMu.Unlock()
		return nil
	}
	a.warm = nil
	a.warmMu.Unlock()
	a.diagf("info", "新会话接管 pi 预热进程 %s", shortPath(w.Dir, 48))
	return w
}

// dropWarmPi forgets a spare whose process ended.
func (a *app) dropWarmPi(id string) {
	a.warmMu.Lock()
	if a.warm != nil && a.warm.ID == id {
		a.warm = nil
	}
	a.warmMu.Unlock()
}

// warmPiInfo is the spare the diagnostics page lists.
func (a *app) warmPiInfo() *warmPi {
	a.warmMu.Lock()
	defer a.warmMu.Unlock()
	return a.warm
}

// expireWarmPi retires a spare nobody adopted in time.
func (a *app) expireWarmPi(w *warmPi, after time.Duration) {
	a.cx.AfterFunc(after, func() {
		a.warmMu.Lock()
		if a.warm != w {
			a.warmMu.Unlock()
			return
		}
		a.warm = nil
		a.warmMu.Unlock()
		go w.C.stop()
		a.diagf("info", "pi 预热进程在 %s 内未使用，已回收", shortDuration(after))
	})
}

// expireHeldWarmPi retires a spare a session holds but nobody used, so an
// idle tab does not keep a Node process alive forever.
func (a *app) expireHeldWarmPi(s *session, w *warmPi, after time.Duration) {
	a.cx.AfterFunc(after, func() {
		if s.warmPi != w {
			return
		}
		a.releaseWarmPi(s)
		a.diagf("info", "会话的 pi 预热进程在 %s 内未使用，已回收", shortDuration(after))
	})
}

// retireWarmPi ends a spare by id, from the diagnostics page: the pool's
// spare, or one a session holds while its tab is still empty.
func (a *app) retireWarmPi(id string) {
	a.warmMu.Lock()
	w := a.warm
	matched := w != nil && (id == "" || w.ID == id)
	if matched {
		a.warm = nil
	}
	a.warmMu.Unlock()
	if matched {
		go w.C.stop()
		a.diagf("info", "pi 预热进程已手动结束")
		return
	}
	if s := a.byID[id]; s != nil && s.warmPi != nil {
		a.releaseWarmPi(s)
		a.diagf("info", "会话的 pi 预热进程已手动结束")
	}
}

// releaseWarmPi ends a spare a session held but never used, so a tab that
// moves to ACP or closes does not keep a process alive.
func (a *app) releaseWarmPi(s *session) {
	if s == nil || s.warmPi == nil {
		return
	}
	w := s.warmPi
	s.warmPi = nil
	go w.C.stop()
}
