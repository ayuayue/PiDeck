package main

// The workspace file tree in the right drawer: a lazily expanded listing
// the user can click to mention a path in the composer.

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nsgo-dev/nsgo/core"
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

// fileIndexCache is a workspace's files for the composer's @ mentions,
// scanned in the background and reused while it is fresh.
type fileIndexCache struct {
	mu      sync.Mutex
	root    string
	at      time.Time
	files   []string
	loading bool
}

// fileIndexMax bounds a workspace's mention list.
const fileIndexMax = 4000

// workspaceFiles is the cached file list; a stale or missing list starts
// a background scan and returns what is known now.
func (a *app) workspaceFiles(root string) []string {
	if root == "" {
		return nil
	}
	a.fileIdx.mu.Lock()
	if a.fileIdx.root != root {
		a.fileIdx.root = root
		a.fileIdx.files = nil
		a.fileIdx.at = time.Time{}
		a.fileIdx.loading = false
	}
	files := append([]string(nil), a.fileIdx.files...)
	stale := time.Since(a.fileIdx.at) > 10*time.Second
	start := stale && !a.fileIdx.loading
	if start {
		a.fileIdx.loading = true
	}
	a.fileIdx.mu.Unlock()
	if start {
		go a.scanWorkspaceFiles(root)
	}
	return files
}

// fileIndexBusy reports whether the root's file list is being read.
func (a *app) fileIndexBusy(root string) bool {
	a.fileIdx.mu.Lock()
	defer a.fileIdx.mu.Unlock()
	return a.fileIdx.root == root && a.fileIdx.loading
}

// walkWorkspaceFiles lists a workspace's files, skipping the folders that
// never belong in a prompt.
func walkWorkspaceFiles(root string) []string {
	var files []string
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != root && skipMentionDir(d.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		files = append(files, filepath.ToSlash(rel))
		if len(files) >= fileIndexMax {
			return filepath.SkipAll
		}
		return nil
	})
	return files
}

// scanWorkspaceFiles walks a workspace, skipping the folders that never
// belong in a prompt, and announces the list.
func (a *app) scanWorkspaceFiles(root string) {
	files := walkWorkspaceFiles(root)
	sort.Strings(files)
	a.fileIdx.mu.Lock()
	if a.fileIdx.root == root {
		a.fileIdx.files = files
		a.fileIdx.at = time.Now()
	}
	a.fileIdx.loading = false
	a.fileIdx.mu.Unlock()
	a.cx.Post(func() { a.filesRev.Update(func(n int) int { return n + 1 }) })
}

// skipMentionDir reports whether a folder is noise for @ completion.
func skipMentionDir(name string) bool {
	if strings.HasPrefix(name, ".") {
		return true
	}
	switch name {
	case "node_modules", "vendor", "dist", "build", "target", "__pycache__", "bin", "obj":
		return true
	}
	return false
}

// mentionMatches lists the files a partial @path matches, best first.
func mentionMatches(files []string, token string, limit int) []string {
	token = strings.ToLower(strings.TrimSpace(token))
	var prefix, contains []string
	for _, f := range files {
		lower := strings.ToLower(f)
		base := strings.ToLower(filepath.Base(f))
		switch {
		case token == "" || strings.HasPrefix(lower, token) || strings.HasPrefix(base, token):
			prefix = append(prefix, f)
		case strings.Contains(lower, token):
			contains = append(contains, f)
		}
		if len(prefix) >= limit {
			break
		}
	}
	out := append(prefix, contains...)
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// fileMatches ranks files for quick open: names that start with the query
// first, then names that contain it, then paths that do.
func fileMatches(files []string, query string, limit int) []string {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		if len(files) > limit {
			return files[:limit]
		}
		return files
	}
	var byName, inName, inPath []string
	for _, f := range files {
		lower := strings.ToLower(f)
		base := strings.ToLower(filepath.Base(f))
		switch {
		case strings.HasPrefix(base, q):
			byName = append(byName, f)
		case strings.Contains(base, q):
			inName = append(inName, f)
		case strings.Contains(lower, q):
			inPath = append(inPath, f)
		}
		if len(byName) >= limit {
			break
		}
	}
	// Within a tier the shortest path is the likeliest answer.
	shortest := func(s []string) {
		sort.SliceStable(s, func(i, j int) bool {
			if len(s[i]) != len(s[j]) {
				return len(s[i]) < len(s[j])
			}
			return s[i] < s[j]
		})
	}
	shortest(byName)
	shortest(inName)
	shortest(inPath)
	out := append(byName, inName...)
	out = append(out, inPath...)
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// recentFileMax bounds the editor's recent file list.
const recentFileMax = 20

// pushRecent puts a path first in a bounded list, without duplicates.
func pushRecent(list []string, path string, max int) []string {
	if path == "" {
		return list
	}
	out := []string{path}
	for _, p := range list {
		if p == path || len(out) >= max {
			continue
		}
		out = append(out, p)
	}
	return out
}
