//go:build !js && !android && !ios

package workbench

// Repository polling and state publication for the Git drawer.

import (
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/nsgo-dev/nsgo/base/commitgraph"
	"github.com/nsgo-dev/nsgo/core"
)

// gitRepo reads one project's repository and runs its operations.
type gitRepo struct {
	cx *core.Scope

	mu     sync.Mutex
	path   string
	target target

	state    *core.Signal[gitState]
	history  *commitgraph.History
	logQuery *core.Signal[string]
	msg      *core.Signal[string]
	amend    *core.Signal[bool]
	busy     *core.Signal[string]
	err      *core.Signal[string]

	// onResult lets the app toast an action's outcome.
	onResult func(label string, err error)

	// logLimit grows as the history's "more" is pressed.
	logLimit int

	seq     int
	working bool
	running bool
	pending bool
}

// newGitRepo builds the panel's state.
func newGitRepo(cx *core.Scope) *gitRepo {
	g := &gitRepo{
		cx:       cx,
		state:    core.NewSignalFunc(cx, gitState{Checked: true}, nil),
		logQuery: core.NewSignal(cx, ""),
		logLimit: 50,
		msg:      core.NewSignal(cx, ""),
		amend:    core.NewSignal(cx, false),
		busy:     core.NewSignal(cx, ""),
		err:      core.NewSignal(cx, ""),
	}
	g.history = commitgraph.NewHistory(cx, func() []commitgraph.Commit {
		st := g.state.Get()
		out := make([]commitgraph.Commit, 0, len(st.Commits))
		for _, c := range st.Commits {
			out = append(out, commitgraph.Commit{Hash: c.Hash, Parents: c.Parents})
		}
		return out
	}, nil)
	return g
}

// repo is the repository commands run in.
func (r *gitRepo) repo() (target, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.target, r.path
}

// attach points the panel at a workspace, if it is another one, and reads
// its repository.
func (r *gitRepo) attach(ws *workspace) bool {
	path, t := "", localTarget
	if ws != nil {
		path, t = ws.Path, ws.Target
	}
	r.mu.Lock()
	same := path == r.path && t.key() == r.target.key()
	if !same {
		r.path, r.target = path, t
	}
	r.mu.Unlock()
	if same {
		return false
	}
	r.seq++
	r.working, r.running, r.pending = false, false, false
	r.logLimit = 50
	r.logQuery.Set("")
	r.err.Set("")
	r.busy.Set("")
	r.msg.Set("")
	r.amend.Set(false)
	if path == "" {
		r.state.Set(gitState{Checked: true})
		return true
	}
	r.state.Set(gitState{Loading: true})
	r.refreshAll()
	return true
}

// refreshAll reads the status, the history and the branches.
func (r *gitRepo) refreshAll() {
	t, path := r.repo()
	if path == "" {
		return
	}
	if r.working {
		r.pending = true
		return
	}
	r.working = true
	r.state.Update(func(s gitState) gitState { s.Loading = true; return s })
	seq := r.seq
	go func() {
		st := readGitState(t, path, r.logLimit)
		r.cx.Post(func() {
			if seq != r.seq {
				return
			}
			r.working = false
			st.Loading = false
			st.Checked = true
			r.state.Set(st)
			if r.pending {
				r.pending = false
				r.refreshAll()
			}
		})
	}()
}

// loadMore asks for another page of history.
func (r *gitRepo) loadMore() {
	if r.logLimit >= 500 {
		return
	}
	r.logLimit += 50
	r.refreshAll()
}

// poll reads the status alone, for the drawer's periodic refresh.
func (r *gitRepo) poll() {
	t, path := r.repo()
	if path == "" || r.working || r.running {
		return
	}
	cur := r.state.GetUntracked()
	if cur.NotRepo {
		return
	}
	r.working = true
	seq := r.seq
	go func() {
		st, err := readGitStatus(t, path)
		r.cx.Post(func() {
			if seq != r.seq {
				return
			}
			r.working = false
			old := r.state.GetUntracked()
			switch {
			case err != nil:
				old.Error, old.Loading, old.Checked = err.Error(), false, true
				r.state.Set(old)
			case st.NotRepo:
				st.Checked, st.Loading = true, false
				r.state.Set(st)
			default:
				st.Root, st.Commits, st.Branches = old.Root, old.Commits, old.Branches
				st.Checked, st.Loading = true, false
				r.state.Set(st)
			}
			if r.pending {
				r.pending = false
				r.refreshAll()
			}
		})
	}()
}

// readGitState reads a repository's status, root, history and branches.
func readGitState(t target, dir string, logLimit int) gitState {
	if logLimit <= 0 {
		logLimit = 50
	}
	st, err := readGitStatus(t, dir)
	if err != nil {
		return gitState{Checked: true, Error: err.Error()}
	}
	if st.NotRepo {
		return st
	}
	if out, _, code, err := gitRun(t, dir, 20*time.Second, "rev-parse", "--show-toplevel"); err == nil && code == 0 {
		st.Root = strings.TrimSpace(out)
	}
	if out, _, code, err := gitRun(t, dir, 30*time.Second, "--no-pager", "log", "-n", fmt.Sprint(logLimit), "--date=iso-strict",
		"--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%P%x1e"); err == nil && code == 0 {
		st.Commits = parseGitLog(out)
		st.LogLimit = logLimit
	}
	if out, _, code, err := gitRun(t, dir, 20*time.Second, "branch", "--list", "--format=%(refname:short)"); err == nil && code == 0 {
		st.Branches = parseGitBranches(out)
	}
	if out, _, code, err := gitRun(t, dir, 20*time.Second, "branch", "-r", "--format=%(refname:short)"); err == nil && code == 0 {
		st.RemoteBranches = parseRemoteBranches(out)
	}
	if out, _, code, err := gitRun(t, dir, 20*time.Second, "tag", "--sort=-creatordate"); err == nil && code == 0 {
		st.Tags = parseGitTags(out)
	}
	if out, _, code, err := gitRun(t, dir, 20*time.Second, "remote", "-v"); err == nil && code == 0 {
		st.Remotes = parseGitRemotes(out)
	}
	return st
}

// fileMarks maps every changed file's absolute path to its status, for
// the file tree. Paths are relative to the repository root, which may be
// above the workspace.
func (a *app) fileMarks() map[string]gitFile {
	if a.git == nil {
		return nil
	}
	st := a.git.state.Get()
	if !st.IsRepo || st.Root == "" {
		return nil
	}
	out := make(map[string]gitFile, len(st.Files))
	for _, f := range st.Files {
		p := filepath.Clean(filepath.Join(st.Root, filepath.FromSlash(f.Path)))
		out[p] = f
	}
	return out
}

// changedDirs are the folders above a changed file, so a collapsed
// folder can show that something under it changed.
func changedDirs(marks map[string]gitFile, root string) map[string]bool {
	if len(marks) == 0 {
		return nil
	}
	root = filepath.Clean(root)
	out := map[string]bool{}
	for path := range marks {
		dir := filepath.Dir(path)
		for {
			out[dir] = true
			if dir == root {
				break
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return out
}

// gitMarkColor is a status letter's tone.
func gitMarkColor(mark string) string {
	switch mark {
	case "A":
		return "up"
	case "D", "U":
		return "down"
	case "M", "R", "C", "T":
		return "warn"
	}
	return "faint"
}
