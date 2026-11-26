//go:build !js && !android && !ios

package workbench

// A prewarmed ACP agent: the CLI's handshake is the slow part of switching
// a session to ACP (an npx preset loads Node and its package, a big CLI
// reads its own config), and it does not depend on the session. A project
// that has used an agent before keeps its default preset's handshake done,
// so the next ACP session only asks for a session.

import (
	"strings"
	"time"
)

// acpWarmTTL is how long a handshaken agent waits for a session. Agents
// hold credentials and a Node runtime, so it is shorter than pi's spare.
const acpWarmTTL = 5 * time.Minute

// warmACP is one handshaken agent waiting for a session.
type warmACP struct {
	key     string
	Preset  acpPreset
	Cwd     string
	C       *acpClient
	Started time.Time
}

// acpWarmKey identifies a launch: the same preset, command and arguments
// in the same project. Environment values are secrets and are not part of
// the key; a preset edit changes the command or arguments instead.
func acpWarmKey(p acpPreset, cwd string) string {
	return p.ID + "\x00" + p.Command + "\x00" + strings.Join(p.Args, "\x00") + "\x00" + cwd
}

// ensureWarmACP handshakes the preset ahead of a session, unless a spare
// for it is already there.
func (a *app) ensureWarmACP(p acpPreset, cwd string) {
	if !a.warmOK || strings.TrimSpace(p.Command) == "" || strings.TrimSpace(cwd) == "" {
		return
	}
	key := acpWarmKey(p, cwd)
	a.acpWarmMu.Lock()
	if a.acpWarm != nil && a.acpWarm.key == key {
		a.acpWarmMu.Unlock()
		return
	}
	if a.acpWarmSpawning == key {
		a.acpWarmMu.Unlock()
		return
	}
	old := a.acpWarm
	a.acpWarm = nil
	a.acpWarmSpawning = key
	a.acpWarmMu.Unlock()
	if old != nil {
		go old.C.stop()
	}
	started := time.Now()
	go func() {
		c, err := startACP(cwd, p.Command, p.Args, p.envList(), nil, nil, func(error) { a.dropWarmACP(key) })
		if err != nil {
			a.finishWarmACPSpawn(key, nil)
			a.diagf("warn", "ACP 预热失败 %s：%v", p.Name, err)
			return
		}
		c.setHooks(acpHooks{exit: func(error) { a.dropWarmACP(key) }, protocol: func(method string, elapsed time.Duration, err error) {
			a.recordACPCall("", method, elapsed, err)
		}})
		a.logEvent("info", "acp", "", "ACP 预热启动参数：%s", diagCommand(p.Command, p.Args))
		if _, err := c.initialize(); err != nil {
			c.stop()
			a.finishWarmACPSpawn(key, nil)
			a.diagf("warn", "ACP 预热握手失败 %s：%v", p.Name, err)
			return
		}
		w := &warmACP{key: key, Preset: p, Cwd: cwd, C: c, Started: time.Now()}
		if !a.finishWarmACPSpawn(key, w) {
			return
		}
		a.diagf("info", "ACP 预热就绪 %s（%s）", p.Name, time.Since(started).Round(time.Millisecond))
		a.expireWarmACP(w, acpWarmTTL)
	}()
}

// finishWarmACPSpawn records the spawn's result when nobody else took the
// slot, and ends a process it could not keep.
func (a *app) finishWarmACPSpawn(key string, w *warmACP) bool {
	a.acpWarmMu.Lock()
	if a.acpWarmSpawning == key {
		a.acpWarmSpawning = ""
	}
	kept := w != nil && a.acpWarm == nil
	if kept {
		a.acpWarm = w
	}
	a.acpWarmMu.Unlock()
	if w != nil && !kept {
		go w.C.stop()
	}
	return kept
}

// takeACPWarm hands a handshaken agent to a session, or reports none.
func (a *app) takeACPWarm(p acpPreset, cwd string) *acpClient {
	key := acpWarmKey(p, cwd)
	a.acpWarmMu.Lock()
	w := a.acpWarm
	if w == nil || w.key != key || w.C.isClosed() {
		a.acpWarmMu.Unlock()
		return nil
	}
	a.acpWarm = nil
	a.acpWarmMu.Unlock()
	a.diagf("info", "ACP 会话接管预热进程 %s", p.Name)
	return w.C
}

// dropWarmACP forgets a spare whose process ended.
func (a *app) dropWarmACP(key string) {
	a.acpWarmMu.Lock()
	if a.acpWarm != nil && a.acpWarm.key == key {
		a.acpWarm = nil
	}
	a.acpWarmMu.Unlock()
}

// expireWarmACP retires a handshaken agent nobody adopted in time.
func (a *app) expireWarmACP(w *warmACP, after time.Duration) {
	a.cx.AfterFunc(after, func() {
		a.acpWarmMu.Lock()
		if a.acpWarm != w {
			a.acpWarmMu.Unlock()
			return
		}
		a.acpWarm = nil
		a.acpWarmMu.Unlock()
		go w.C.stop()
		a.diagf("info", "ACP 预热进程 %s 在 %s 内未使用，已回收", w.Preset.Name, shortDuration(after))
	})
}

// warmACPInfo is the spare the diagnostics page lists.
func (a *app) warmACPInfo() *warmACP {
	a.acpWarmMu.Lock()
	defer a.acpWarmMu.Unlock()
	return a.acpWarm
}

// retireWarmACP ends the spare by preset id, from the diagnostics page.
func (a *app) retireWarmACP(presetID string) {
	a.acpWarmMu.Lock()
	w := a.acpWarm
	if w == nil || (presetID != "" && w.Preset.ID != presetID) {
		a.acpWarmMu.Unlock()
		return
	}
	a.acpWarm = nil
	a.acpWarmMu.Unlock()
	go w.C.stop()
	a.diagf("info", "ACP 预热进程 %s 已手动结束", w.Preset.Name)
}

// ensureWarmACPFor keeps the project's default agent warm when it has one.
func (a *app) ensureWarmACPFor(ws *workspace) {
	if ws == nil || ws.ACPPreset == "" || ws.Target.remote() {
		return
	}
	if p := a.acpPresetByID(ws.ACPPreset); p != nil {
		a.ensureWarmACP(*p, ws.Path)
	}
}
