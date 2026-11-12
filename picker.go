package main

// A small folder browser for adding workspaces and importing pi session
// files. It is the app's own rather than a generic picker, so every part
// reports what it is doing: the path loads off the UI thread and the list
// is what the app chose to show.

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/oneo-me/nsgo/core"
)

// pickEntry is one row of the browser.
type pickEntry struct {
	Name  string
	Path  string
	Dir   bool
	Size  int64
	MTime int64
}

// pickerState is the browser's folder and selection.
type pickerState struct {
	cx       *core.Scope
	open     *core.Signal[bool]
	mode     *core.Signal[string] // "workspace" or "import"
	path     *core.Signal[string]
	addr     *core.Signal[string]
	entries  *core.Signal[[]pickEntry]
	selected *core.Signal[string]
	err      *core.Signal[string]
	loading  *core.Signal[bool]
	hidden   *core.Signal[bool]
	gen      int
}

func newPicker(cx *core.Scope) *pickerState {
	return &pickerState{
		cx:       cx,
		open:     core.NewSignal(cx, false),
		mode:     core.NewSignal(cx, "workspace"),
		path:     core.NewSignal(cx, ""),
		addr:     core.NewSignal(cx, ""),
		entries:  core.NewSignalFunc(cx, []pickEntry(nil), nil),
		selected: core.NewSignal(cx, ""),
		err:      core.NewSignal(cx, ""),
		loading:  core.NewSignal(cx, false),
		hidden:   core.NewSignal(cx, false),
	}
}

// show opens the browser in a mode, starting at home.
func (p *pickerState) show(mode string) {
	p.mode.Set(mode)
	p.selected.Set("")
	p.err.Set("")
	p.open.Set(true)
	start := p.path.GetUntracked()
	if start == "" {
		if home, err := os.UserHomeDir(); err == nil {
			start = home
		} else if cwd, err := os.Getwd(); err == nil {
			start = cwd
		}
	}
	p.load(start)
}

// load lists a folder, ignoring a listing a later load replaced.
func (p *pickerState) load(path string) {
	if path == "" {
		return
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		p.err.Set(err.Error())
		return
	}
	p.gen++
	gen := p.gen
	p.loading.Set(true)
	p.err.Set("")
	go func() {
		entries, err := readDir(abs)
		p.cx.Post(func() {
			if gen != p.gen {
				return
			}
			p.loading.Set(false)
			if err != nil {
				p.err.Set(err.Error())
				return
			}
			p.path.Set(abs)
			p.addr.Set(abs)
			p.entries.Set(entries)
			p.selected.Set("")
		})
	}()
}

// readDir lists a folder, folders first, bounded in size.
func readDir(path string) ([]pickEntry, error) {
	list, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}
	out := make([]pickEntry, 0, len(list))
	for _, e := range list {
		if len(out) >= 300 {
			break
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, pickEntry{Name: e.Name(), Path: filepath.Join(path, e.Name()), Dir: e.IsDir(),
			Size: info.Size(), MTime: info.ModTime().Unix()})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Dir != out[j].Dir {
			return out[i].Dir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

// up opens the parent folder.
func (p *pickerState) up() {
	cur := p.path.GetUntracked()
	if cur == "" {
		return
	}
	parent := filepath.Dir(cur)
	if parent == cur {
		return
	}
	p.load(parent)
}

// visible is the entries the hidden toggle allows; in import mode only
// folders and session files show.
func (p *pickerState) visible() []pickEntry {
	hidden := p.hidden.Get()
	importing := p.mode.Get() == "import"
	var out []pickEntry
	for _, e := range p.entries.Get() {
		if !hidden && strings.HasPrefix(e.Name, ".") {
			continue
		}
		if importing && !e.Dir && !strings.HasSuffix(strings.ToLower(e.Name), ".jsonl") {
			continue
		}
		out = append(out, e)
	}
	return out
}

// chosen is the path the dialog's main action takes.
func (p *pickerState) chosen() (string, bool) {
	if p.mode.Get() == "import" {
		sel := p.selected.Get()
		if sel != "" {
			return sel, true
		}
		return "", false
	}
	path := p.path.Get()
	if path == "" {
		return "", false
	}
	if sel := p.selected.Get(); sel != "" {
		for _, e := range p.entries.Get() {
			if e.Path == sel && e.Dir {
				return sel, true
			}
		}
	}
	return path, true
}

// places are shortcuts to folders worth starting from.
func (p *pickerState) places(workspaces []*workspace) []pickEntry {
	var out []pickEntry
	seen := map[string]bool{}
	add := func(name, path string) {
		if path == "" || seen[path] {
			return
		}
		seen[path] = true
		out = append(out, pickEntry{Name: name, Path: path, Dir: true})
	}
	if home, err := os.UserHomeDir(); err == nil {
		add("主目录", home)
	}
	if cwd, err := os.Getwd(); err == nil {
		add("当前目录", cwd)
	}
	for _, ws := range workspaces {
		add(ws.label(), ws.Path)
	}
	return out
}
