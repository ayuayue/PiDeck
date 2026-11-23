//go:build !js && !android && !ios

package workbench

// Diagnostics: a small in-memory log, a rotating file, and a snapshot of
// what the app is running, for the settings page and for bug reports.

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"example.com/pideck-v2/internal/appinfo"
)

// diagEvent is one log line.
type diagEvent struct {
	Time  time.Time
	Level string
	Text  string
}

// diagRing is how many events the app keeps in memory.
const diagRing = 300

// diagFileLimit is when the log file rotates.
const diagFileLimit = 1 << 20

// procInfo is one running process the app owns.
type procInfo struct {
	Kind   string
	ID     string
	Name   string
	Detail string
	State  string
	PID    int
	// CanStop says why the row has no stop button: a process the app did
	// not start, or one already gone.
	CanStop bool
	Started time.Time
	Stderr  string
}

// diagMemory is what the diagnostics page's figures come from.
type diagMemory struct {
	HeapAlloc  uint64
	HeapSys    uint64
	HeapIdle   uint64
	Goroutines int
	Uptime     time.Duration
}

// diagProcs and diagLogEvents carry the page's lists: a signal's value must
// be comparable, so the lists travel by pointer.
type diagProcs []procInfo
type diagLogEvents []diagEvent

// diagRefresh fills what the diagnostics page shows. It runs off the page's
// own redraw, so a figure changing never rebuilds the scroll view under the
// person reading it.
func (a *app) diagRefresh() {
	if a.diagMem == nil {
		return
	}
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	uptime := time.Duration(0)
	if !a.startedAt.IsZero() {
		uptime = a.cx.Now().Sub(a.startedAt)
	}
	a.diagMem.Set(diagMemory{HeapAlloc: mem.HeapAlloc, HeapSys: mem.Sys, HeapIdle: mem.HeapIdle,
		Goroutines: runtime.NumGoroutine(), Uptime: uptime})
	procs := diagProcs(a.processList())
	a.diagProcs.Set(&procs)
	events := diagLogEvents(a.diagSnapshot())
	a.diagLog.Set(&events)
}

// stopProcess ends one process the diagnostics page lists: a pi session's
// engine, which leaves the transcript and its tab and starts again with the
// next message, or a terminal tab, which closes.
func (a *app) stopProcess(p procInfo) {
	switch p.Kind {
	case "pi":
		if s := a.byID[p.ID]; s != nil {
			a.closeAgent(s)
		}
	case "shell":
		if a.term != nil {
			a.term.remove(p.ID)
		}
	}
	a.diagRefresh()
}

// initDiag opens the log file and records the start.
func (a *app) initDiag() {
	if a.st == nil {
		return
	}
	dir := filepath.Join(a.st.dir, "logs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	path := filepath.Join(dir, "pideck.log")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err == nil {
		a.diagFile = f
		a.diagPath = path
		if info, err := f.Stat(); err == nil {
			a.diagSize = int(info.Size())
		}
	}
	a.startedAt = time.Now()
	if a.cx != nil {
		a.cx.Cleanup(a.closeDiag)
	}
	a.diagf("info", "应用启动 %s · %s/%s", appinfo.Version, runtime.GOOS, runtime.GOARCH)
}

// diagf records one line, in memory and on disk.
func (a *app) diagf(level, format string, args ...any) {
	ev := diagEvent{Time: time.Now(), Level: level, Text: fmt.Sprintf(format, args...)}
	a.diagMu.Lock()
	defer a.diagMu.Unlock()
	a.diagEvents = append(a.diagEvents, ev)
	if len(a.diagEvents) > diagRing {
		a.diagEvents = a.diagEvents[len(a.diagEvents)-diagRing:]
	}
	if a.diagFile == nil {
		return
	}
	line := fmt.Sprintf("%s [%s] %s\n", ev.Time.Format(time.RFC3339), level, ev.Text)
	n, _ := a.diagFile.WriteString(line)
	a.diagSize += n
	if a.diagSize > diagFileLimit {
		a.rotateDiag()
	}
}

// rotateDiag moves the log aside and starts a new one; the caller holds
// diagMu.
func (a *app) rotateDiag() {
	if a.diagFile == nil || a.diagPath == "" {
		return
	}
	_ = a.diagFile.Close()
	_ = os.Rename(a.diagPath, a.diagPath+".1")
	f, err := os.OpenFile(a.diagPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		a.diagFile = nil
		return
	}
	a.diagFile = f
	a.diagSize = 0
}

// closeDiag closes the log file.
func (a *app) closeDiag() {
	a.diagMu.Lock()
	defer a.diagMu.Unlock()
	if a.diagFile != nil {
		_ = a.diagFile.Close()
		a.diagFile = nil
	}
}

// diagSnapshot copies the newest events, oldest first.
func (a *app) diagSnapshot() []diagEvent {
	a.diagMu.Lock()
	defer a.diagMu.Unlock()
	out := make([]diagEvent, len(a.diagEvents))
	copy(out, a.diagEvents)
	return out
}

// clearDiag forgets the in-memory events; the file stays.
func (a *app) clearDiag() {
	a.diagMu.Lock()
	a.diagEvents = nil
	a.diagMu.Unlock()
}

// diagDir is the folder the log file lives in.
func (a *app) diagDir() string {
	if a.diagPath == "" {
		return ""
	}
	return filepath.Dir(a.diagPath)
}

// processList is the pi sessions and terminals the app is running.
func (a *app) processList() []procInfo {
	var out []procInfo
	for _, s := range a.all {
		if s.engine == nil {
			continue
		}
		state := "就绪"
		switch s.status.GetUntracked() {
		case statusStarting:
			state = "启动中"
		case statusRunning:
			state = "运行中"
		case statusWaiting:
			state = "等待"
		case statusFailed:
			state = "失败"
		}
		out = append(out, procInfo{Kind: "pi", ID: s.ID, Name: s.title.GetUntracked(),
			Detail: shortPath(s.WS, 48), State: state, PID: s.engine.pid(), CanStop: true,
			Started: s.updated.GetUntracked(), Stderr: s.engine.stderrText()})
	}
	if a.term != nil {
		for _, tab := range a.term.tabs.GetUntracked() {
			state := "运行中"
			if tab.state != nil {
				switch tab.state.GetUntracked() {
				case termStarting:
					state = "启动中"
				case termExited:
					state = "已退出"
				case termFailed:
					state = "失败"
				}
			}
			out = append(out, procInfo{Kind: "shell", ID: tab.ID, Name: tab.Title.GetUntracked(),
				Detail: shortPath(tab.Cwd, 48), State: state, CanStop: tab.state == nil || tab.state.GetUntracked() != termExited})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Kind < out[j].Kind })
	return out
}

// diagnosticText is the report copied for a bug report.
func (a *app) diagnosticText() string {
	var b strings.Builder
	fmt.Fprintf(&b, "PiDeck V2 %s\n", appinfo.Version)
	fmt.Fprintf(&b, "%s/%s · Go %s\n", runtime.GOOS, runtime.GOARCH, runtime.Version())
	if a.st != nil {
		fmt.Fprintf(&b, "数据目录：%s\n", a.st.dir)
	}
	if a.env != nil {
		info := a.env.GetUntracked()
		fmt.Fprintf(&b, "pi：%s %s\n", info.PiPath, info.PiVersion)
		if info.PiError != "" {
			fmt.Fprintf(&b, "pi 错误：%s\n", info.PiError)
		}
	}
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	fmt.Fprintf(&b, "goroutine：%d · 堆：%.1f MB · 已提交：%.1f MB · 空闲：%.1f MB · 启动于 %s\n",
		runtime.NumGoroutine(), float64(mem.HeapAlloc)/(1<<20), float64(mem.Sys)/(1<<20),
		float64(mem.HeapIdle)/(1<<20), a.startedAt.Format(time.RFC3339))
	b.WriteString("\n进程：\n")
	procs := a.processList()
	if len(procs) == 0 {
		b.WriteString("  （没有运行中的进程）\n")
	}
	for _, p := range procs {
		fmt.Fprintf(&b, "  %s · %s · %s · %s", p.Kind, p.Name, p.State, p.Detail)
		if p.PID > 0 {
			fmt.Fprintf(&b, " · pid %d", p.PID)
		}
		b.WriteString("\n")
	}
	b.WriteString("\n最近日志：\n")
	for _, ev := range a.diagSnapshot() {
		fmt.Fprintf(&b, "  %s [%s] %s\n", ev.Time.Format("15:04:05"), ev.Level, ev.Text)
	}
	return b.String()
}
