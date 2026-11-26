//go:build !js && !android && !ios

package workbench

// Repository polling and state publication for the Git drawer.

import (
	"fmt"
	"path/filepath"
	"strconv"
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
	// logSearch is the query's matches over the whole history; the box's
	// debounce fills it, so typing does not run git per keystroke.
	logSearch     *core.Signal[*gitSearch]
	searchLimit   *core.Signal[int]
	searchTimer   func() bool
	searching     bool
	searchPending bool
	msg           *core.Signal[string]
	amend         *core.Signal[bool]
	busy          *core.Signal[string]
	err           *core.Signal[string]

	// The drawer's own controls: how the changes are listed, which folders
	// are folded, how many rows of each section are shown. They outlive a
	// status read, so the panel does not jump while the user reads it.
	view         *core.Signal[string]
	collapsed    *core.Signal[map[string]bool]
	filesShown   *core.Signal[int]
	historyShown *core.Signal[int]
	// recentOpen is the commit box's recent-message menu: the status poll
	// rebuilds the box, and an open menu must not close under the pointer.
	recentOpen *core.Signal[bool]

	// onResult lets the app toast an action's outcome: what it did, and the
	// line the action reports under it.
	onResult func(label, detail string, err error)
	onLog    func(level, text string)

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
		cx:           cx,
		state:        core.NewSignalFunc(cx, gitState{Checked: true}, nil),
		logQuery:     core.NewSignal(cx, ""),
		logSearch:    core.NewSignal(cx, (*gitSearch)(nil)),
		searchLimit:  core.NewSignal(cx, gitSearchPage),
		logLimit:     50,
		msg:          core.NewSignal(cx, ""),
		amend:        core.NewSignal(cx, false),
		busy:         core.NewSignal(cx, ""),
		err:          core.NewSignal(cx, ""),
		view:         core.NewSignal(cx, gitViewFlat),
		collapsed:    core.NewSignalFunc(cx, map[string]bool(nil), nil),
		filesShown:   core.NewSignal(cx, gitFilesShown),
		historyShown: core.NewSignal(cx, gitHistoryShown),
		recentOpen:   core.NewSignal(cx, false),
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

// gitViewTree and gitViewFlat are the two ways the changes are listed.
const (
	gitViewTree = "tree"
	gitViewFlat = "flat"
)

// The rows each section shows before the rest waits behind a button: a
// long list would push the history off the panel.
const (
	gitFilesShown   = 10
	gitFilesAll     = 1 << 20
	gitHistoryShown = 8
	gitHistoryPage  = 20
	// gitSearchPage is how many matches one search reads, and the step its
	// "earlier" repeats; gitSearchDebounce is how long typing waits.
	gitSearchPage     = 100
	gitSearchDebounce = 250 * time.Millisecond
)

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
	if r.searchTimer != nil {
		r.searchTimer()
		r.searchTimer = nil
	}
	r.searching, r.searchPending = false, false
	r.logSearch.Set(nil)
	r.searchLimit.Set(gitSearchPage)
	r.err.Set("")
	r.busy.Set("")
	r.msg.Set("")
	r.amend.Set(false)
	r.collapsed.Set(nil)
	r.filesShown.Set(gitFilesShown)
	r.historyShown.Set(gitHistoryShown)
	r.recentOpen.Set(false)
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
				// Status polling does not read the menus or history metadata.
				st.Root, st.Commits, st.Branches = old.Root, old.Commits, old.Branches
				st.RemoteBranches, st.Tags, st.Remotes = old.RemoteBranches, old.Tags, old.Remotes
				st.LogLimit = old.LogLimit
				st.Total = old.Total
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
		"--pretty=format:"+gitLogFormat); err == nil && code == 0 {
		st.Commits = parseGitLog(out)
		st.LogLimit = logLimit
	}
	st.Total = len(st.Commits)
	if out, _, code, err := gitRun(t, dir, 20*time.Second, "rev-list", "--count", "HEAD"); err == nil && code == 0 {
		if n, convErr := strconv.Atoi(strings.TrimSpace(out)); convErr == nil && n > 0 {
			st.Total = n
		}
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
