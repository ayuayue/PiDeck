package main

// The workspace file tree in the right drawer: a lazily expanded listing
// the user can click to mention a path in the composer.

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/oneo-me/nsgo/core"
)

// fileEntry is one directory entry, read off the UI thread.
type fileEntry struct {
	Name string
	Path string
	Dir  bool
}

// fileNode is one visible row of the tree.
type fileNode struct {
	Path     string
	Name     string
	Dir      bool
	Depth    int
	Expanded bool
	Trunc    bool
}

// fileTree is the drawer's tree.
type fileTree struct {
	cx     *core.Scope
	root   *core.Signal[string]
	nodes  *core.Signal[[]fileNode]
	hidden *core.Signal[bool]
	busy   *core.Signal[bool]

	dirs       map[string][]fileEntry
	expanded   map[string]bool
	generation int
}

func newFileTree(cx *core.Scope) *fileTree {
	return &fileTree{
		cx:       cx,
		root:     core.NewSignal(cx, ""),
		nodes:    core.NewSignalFunc(cx, []fileNode(nil), nil),
		hidden:   core.NewSignal(cx, false),
		busy:     core.NewSignal(cx, false),
		dirs:     map[string][]fileEntry{},
		expanded: map[string]bool{},
	}
}

// watch points the tree at a workspace folder, reloading when it changes.
func (t *fileTree) watch(path string) {
	if path == "" || t.root.GetUntracked() == path {
		return
	}
	t.root.Set(path)
	t.expanded = map[string]bool{}
	t.dirs = map[string][]fileEntry{}
	t.generation++
	gen := t.generation
	t.load(path, gen, func() { t.rebuild() })
}

// toggle opens or closes a directory row.
func (t *fileTree) toggle(path string) {
	if t.expanded[path] {
		delete(t.expanded, path)
		t.rebuild()
		return
	}
	if _, ok := t.dirs[path]; ok {
		t.expanded[path] = true
		t.rebuild()
		return
	}
	t.load(path, t.generation, func() {
		t.expanded[path] = true
		t.rebuild()
	})
}

// reload rereads every open directory.
func (t *fileTree) reload() {
	root := t.root.GetUntracked()
	if root == "" {
		return
	}
	t.generation++
	gen := t.generation
	t.dirs = map[string][]fileEntry{}
	dirs := []string{root}
	for path := range t.expanded {
		dirs = append(dirs, path)
	}
	remaining := len(dirs)
	if remaining == 0 {
		return
	}
	t.busy.Set(true)
	for _, dir := range dirs {
		t.load(dir, gen, func() {
			remaining--
			if remaining <= 0 {
				t.busy.Set(false)
				t.rebuild()
			}
		})
	}
}

// load lists one directory off the UI thread.
func (t *fileTree) load(path string, gen int, done func()) {
	go func() {
		entries, err := os.ReadDir(path)
		var out []fileEntry
		if err == nil {
			for _, e := range entries {
				if len(out) >= 400 {
					out = append(out, fileEntry{Name: "…", Path: path, Dir: false})
					break
				}
				name := e.Name()
				if e.IsDir() {
					out = append(out, fileEntry{Name: name, Path: filepath.Join(path, name), Dir: true})
				} else {
					out = append(out, fileEntry{Name: name, Path: filepath.Join(path, name)})
				}
			}
		}
		sort.SliceStable(out, func(i, j int) bool {
			if out[i].Dir != out[j].Dir {
				return out[i].Dir
			}
			return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
		})
		t.cx.Post(func() {
			if gen != t.generation {
				return
			}
			t.dirs[path] = out
			if done != nil {
				done()
			}
		})
	}()
}

// rebuild flattens the expanded tree.
func (t *fileTree) rebuild() {
	root := t.root.GetUntracked()
	if root == "" {
		t.nodes.Set(nil)
		return
	}
	hidden := t.hidden.GetUntracked()
	var out []fileNode
	var walk func(path string, depth int)
	walk = func(path string, depth int) {
		for _, e := range t.dirs[path] {
			if !hidden && strings.HasPrefix(e.Name, ".") {
				continue
			}
			node := fileNode{Path: e.Path, Name: e.Name, Dir: e.Dir, Depth: depth, Expanded: t.expanded[e.Path]}
			out = append(out, node)
			if e.Dir && t.expanded[e.Path] {
				walk(e.Path, depth+1)
			}
			if len(out) > 3000 {
				return
			}
		}
	}
	walk(root, 0)
	t.nodes.Set(out)
}

// setHidden shows or hides dotfiles.
func (t *fileTree) setHidden(on bool) {
	t.hidden.Set(on)
	t.rebuild()
}

// relative is a path as the composer mentions it.
func (t *fileTree) relative(path string) string {
	root := t.root.GetUntracked()
	if root != "" {
		if rel, err := filepath.Rel(root, path); err == nil {
			return filepath.ToSlash(rel)
		}
	}
	return filepath.ToSlash(path)
}
