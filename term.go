//go:build !js

package main

// The bottom terminal panel: real shells on a target, each tab a
// Ghostty-backed terminal from NSGo's base/terminal. A tab keeps running
// when the panel is closed or another tab is chosen, as a terminal app
// does.

import (
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	sgt "github.com/nsgo-dev/nsgo/base/terminal"
	"github.com/nsgo-dev/nsgo/core"
)

// defaultTerminalHeight is the panel's height when none was dragged.
const defaultTerminalHeight = 280.0

// termState is a tab's lifecycle.
type termState int

const (
	termStarting termState = iota
	termRunning
	termExited
	termFailed
)

// termTab is one terminal and the signals its header and view read.
type termTab struct {
	ID    string
	Cwd   string
	Title *core.Signal[string]
	// Target is where the shell runs.
	Target target

	term *sgt.Terminal
	ref  *sgt.Ref
	// gen changes when a new terminal replaces the tab's program, so the
	// view is built again over it.
	gen    *core.Signal[int]
	state  *core.Signal[termState]
	exit   *core.Signal[int]
	errMsg *core.Signal[string]
	find   *core.Signal[sgt.SearchStatus]

	// run tells a replaced terminal's callbacks from the current one's.
	run    int
	closed bool
	// named says the user named the tab, so the shell's title stops
	// changing it.
	named bool
}

// terminalHost is the panel's state: its tabs, the one in front, the
// search bar and the height the user dragged it to.
type terminalHost struct {
	cx *core.Scope

	open     *core.Signal[bool]
	height   *core.Signal[float64]
	tabs     *core.Signal[[]*termTab]
	active   *core.Signal[string]
	findOpen *core.Signal[bool]
	findText *core.Signal[string]

	count int
	// done says the app is going away; a terminal still starting closes
	// instead of reaching a window that is gone.
	done atomic.Bool
}

// terminals tracks the hosts so the app can hang every shell up after its
// window is gone, and live the terminals themselves, including ones whose
// start has not reached the panel yet.
var (
	terminalsMu sync.Mutex
	terminals   = map[*terminalHost]struct{}{}
	liveTerms   = map[*sgt.Terminal]struct{}{}
)

// trackTerm remembers a terminal until it closes.
func trackTerm(t *sgt.Terminal) {
	terminalsMu.Lock()
	liveTerms[t] = struct{}{}
	terminalsMu.Unlock()
}

// closeTerm closes a terminal and forgets it.
func closeTerm(t *sgt.Terminal) {
	if t == nil {
		return
	}
	terminalsMu.Lock()
	delete(liveTerms, t)
	terminalsMu.Unlock()
	_ = t.Close()
}

// closeAllTerminals closes every host, for the app's end.
func closeAllTerminals() {
	terminalsMu.Lock()
	hosts := make([]*terminalHost, 0, len(terminals))
	for h := range terminals {
		hosts = append(hosts, h)
	}
	terms := make([]*sgt.Terminal, 0, len(liveTerms))
	for t := range liveTerms {
		terms = append(terms, t)
	}
	terminals = map[*terminalHost]struct{}{}
	liveTerms = map[*sgt.Terminal]struct{}{}
	terminalsMu.Unlock()
	for _, h := range hosts {
		h.closeAll()
	}
	for _, t := range terms {
		_ = t.Close()
	}
	// The shells end on their own goroutine; give them a moment so a
	// caller that removes a temp folder right after can.
	deadline := time.Now().Add(time.Second)
	for _, t := range terms {
		left := time.Until(deadline)
		if left <= 0 {
			break
		}
		select {
		case <-t.Done():
		case <-time.After(left):
		}
	}
}

// newTerminalHost builds the panel empty.
func newTerminalHost(cx *core.Scope) *terminalHost {
	h := &terminalHost{
		cx:       cx,
		open:     core.NewSignal(cx, false),
		height:   core.NewSignal(cx, defaultTerminalHeight),
		tabs:     core.NewSignalFunc(cx, []*termTab(nil), nil),
		active:   core.NewSignal(cx, ""),
		findOpen: core.NewSignal(cx, false),
		findText: core.NewSignal(cx, ""),
	}
	terminalsMu.Lock()
	terminals[h] = struct{}{}
	terminalsMu.Unlock()
	cx.Cleanup(func() {
		h.closeAll()
		terminalsMu.Lock()
		delete(terminals, h)
		terminalsMu.Unlock()
	})
	return h
}

// newTab adds a tab and starts its shell.
func (h *terminalHost) newTab(cwd string, t target) *termTab {
	h.count++
	title := fmt.Sprintf("终端 %d", h.count)
	if name := lastPathPart(cwd); name != "" {
		title += " · " + name
	}
	tab := &termTab{
		ID:     fmt.Sprintf("term-%d-%d", h.count, time.Now().UnixNano()),
		Cwd:    cwd,
		Target: t,
		Title:  core.NewSignal(h.cx, title),
		gen:    core.NewSignal(h.cx, 0),
		state:  core.NewSignal(h.cx, termState(termStarting)),
		exit:   core.NewSignal(h.cx, 0),
		errMsg: core.NewSignal(h.cx, ""),
		find:   core.NewSignal(h.cx, sgt.SearchStatus{}),
		ref:    &sgt.Ref{},
	}
	h.tabs.Update(func(list []*termTab) []*termTab { return append(list, tab) })
	h.active.Set(tab.ID)
	h.start(tab)
	return tab
}

// lastPathPart names a folder on any target's separators.
func lastPathPart(p string) string {
	p = strings.TrimRight(strings.ReplaceAll(p, "\\", "/"), "/")
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		p = p[i+1:]
	}
	return p
}

// start gives a tab a new terminal, running where its target says.
func (h *terminalHost) start(tab *termTab) {
	tab.run++
	run := tab.run
	tab.state.Set(termStarting)
	tab.errMsg.Set("")
	tab.find.Set(sgt.SearchStatus{})
	opts := sgt.Options{
		Dir: tab.Cwd,
		Env: []string{"PIDECK_LITE=1"},
		OnTitle: func(title string) {
			// A shell often starts by naming its own executable; the
			// tab's own name serves better than a truncated path.
			if title == "" || strings.HasSuffix(strings.ToLower(title), ".exe") {
				return
			}
			h.cx.Post(func() {
				if !tab.closed && tab.run == run && !tab.named {
					tab.Title.Set(title)
				}
			})
		},
		OnExit: func(code int) {
			h.cx.Post(func() {
				if !tab.closed && tab.run == run {
					tab.state.Set(termExited)
					tab.exit.Set(code)
				}
			})
		},
		OnSearch: func(st sgt.SearchStatus) {
			h.cx.Post(func() {
				if !tab.closed && tab.run == run {
					tab.find.Set(st)
				}
			})
		},
	}
	switch tab.Target.Kind {
	case targetWSL:
		opts.Command = []string{"wsl.exe", "-d", tab.Target.Distro, "--cd", tab.Cwd}
		opts.Dir = "" // wsl.exe chooses its own working directory
	case targetSSH:
		script := "cd " + shellQuote(tab.Cwd) + ` && exec "${SHELL:-sh}" -l`
		opts.Command = []string{"ssh", "-tt", "-o", "ConnectTimeout=10", tab.Target.Host, script}
		opts.Dir = ""
	default:
		opts.Dir = tab.Cwd
	}
	go func() {
		term, err := sgt.New(opts)
		if term != nil {
			trackTerm(term)
		}
		if h.done.Load() {
			closeTerm(term)
			return
		}
		h.cx.Post(func() {
			if tab.closed || tab.run != run {
				closeTerm(term)
				return
			}
			if err != nil {
				tab.state.Set(termFailed)
				tab.errMsg.Set(err.Error())
				tab.gen.Update(func(n int) int { return n + 1 })
				return
			}
			tab.term = term
			tab.state.Set(termRunning)
			tab.gen.Update(func(n int) int { return n + 1 })
		})
	}()
}

// restart replaces a tab's program with a fresh shell.
func (h *terminalHost) restart(tab *termTab) {
	if tab == nil {
		return
	}
	if tab.term != nil {
		closeTerm(tab.term)
		tab.term = nil
	}
	h.start(tab)
}

// remove closes a tab's program and takes it out of the panel.
func (h *terminalHost) remove(id string) {
	var next []*termTab
	index := -1
	list := h.tabs.GetUntracked()
	for i, tab := range list {
		if tab.ID == id {
			index = i
			tab.closed = true
			if tab.term != nil {
				closeTerm(tab.term)
				tab.term = nil
			}
			continue
		}
		next = append(next, tab)
	}
	if index < 0 {
		return
	}
	h.tabs.Set(next)
	if h.active.GetUntracked() == id {
		if h.findOpen.GetUntracked() {
			h.findOpen.Set(false)
			h.findText.Set("")
		}
		switch {
		case len(next) == 0:
			h.active.Set("")
		case index >= len(next):
			h.active.Set(next[len(next)-1].ID)
		default:
			h.active.Set(next[index].ID)
		}
	}
}

// closeAll closes every tab, for the app's end.
func (h *terminalHost) closeAll() {
	h.done.Store(true)
	for _, tab := range h.tabs.GetUntracked() {
		tab.closed = true
		if tab.term != nil {
			closeTerm(tab.term)
			tab.term = nil
		}
	}
}

// find returns a tab by id.
func (h *terminalHost) find(id string) *termTab {
	for _, tab := range h.tabs.GetUntracked() {
		if tab.ID == id {
			return tab
		}
	}
	return nil
}

// activeTab is the tab in front, nil when there is none.
func (h *terminalHost) activeTab() *termTab { return h.find(h.active.GetUntracked()) }

// selectTab brings a tab to the front and ends a search that belonged to
// the one before it.
func (h *terminalHost) selectTab(id string) {
	if h.active.GetUntracked() == id || h.find(id) == nil {
		return
	}
	if old := h.activeTab(); old != nil && h.findOpen.GetUntracked() {
		if old.term != nil {
			old.term.EndSearch()
		}
		old.find.Set(sgt.SearchStatus{})
	}
	h.active.Set(id)
	h.findOpen.Set(false)
	h.findText.Set("")
}

// search tells the tab in front to look for text.
func (h *terminalHost) search(text string) {
	h.findText.Set(text)
	tab := h.activeTab()
	if tab == nil || tab.term == nil {
		return
	}
	tab.term.Search(text)
}

// searchNext and searchPrevious move through the matches.
func (h *terminalHost) searchNext(back bool) {
	tab := h.activeTab()
	if tab == nil || tab.term == nil {
		return
	}
	if back {
		tab.term.SearchPrevious()
		return
	}
	tab.term.SearchNext()
}

// endSearch clears the search and its highlights.
func (h *terminalHost) endSearch() {
	h.findOpen.Set(false)
	h.findText.Set("")
	if tab := h.activeTab(); tab != nil {
		tab.find.Set(sgt.SearchStatus{})
		if tab.term != nil {
			tab.term.EndSearch()
		}
	}
}
