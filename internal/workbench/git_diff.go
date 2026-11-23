//go:build !js && !android && !ios

package workbench

// The Git drawer's patches: one changed file's, a commit's, and one a turn
// changed. They are read off the UI thread and shown in the diff pane.

import (
	"path/filepath"
	"strings"
	"time"
)

// gitShowFileDiff shows a working-tree file's patch in the diff pane.
func (a *app) gitShowFileDiff(f gitFile, staged bool) {
	if a.gitPath() == "" {
		return
	}
	sub := "工作区改动"
	switch {
	case f.Conflicted:
		sub = "有冲突的改动"
	case staged:
		sub = "已暂存的改动"
	}
	args := []string{"diff", "--no-color", "--", f.Path}
	switch {
	case f.Untracked:
		// An untracked file has nothing to diff against but emptiness.
		args = []string{"diff", "--no-index", "--no-color", "--", "/dev/null", f.Path}
	case staged:
		args = []string{"diff", "--cached", "--no-color", "--", f.Path}
	}
	a.showPatch(patchRequest{
		runner: a.git.runner(), args: args, diffExit: true,
		title: f.Path, sub: sub, empty: "（这里没有可显示的差异）", failure: "无法读取改动：\n",
	})
}

// gitShowCommit shows a commit's patch in the diff pane.
func (a *app) gitShowCommit(c gitCommit) {
	if a.gitPath() == "" {
		return
	}
	sub := c.Author
	if !c.Date.IsZero() {
		sub += " · " + c.Date.Format("2006-01-02 15:04")
	}
	a.showPatch(patchRequest{
		runner: a.git.runner(), timeout: 60 * time.Second,
		args:  []string{"--no-pager", "show", "--no-color", "--format=fuller", "--patch", c.Hash},
		title: c.Short + " · " + c.Subject, sub: sub, hash: c.Hash,
		empty: "（这次提交没有可显示的差异）", failure: "无法读取提交：\n",
	})
}

// openChangedFile shows a file a turn changed as what changed in it: its
// patch against the project's HEAD, in the diff pane. A project that is not
// a Git repository, and a path outside the project, open the file itself.
func (a *app) openChangedFile(s *session, raw string) {
	if s == nil || raw == "" || strings.HasSuffix(raw, "…") {
		return
	}
	if i := strings.Index(raw, " 等 "); i > 0 {
		raw = raw[:i]
	}
	path := raw
	if !filepath.IsAbs(path) {
		path = filepath.Join(s.WS, path)
	}
	rel, err := filepath.Rel(s.WS, path)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		a.openEditorFile(s.WS, path)
		return
	}
	rel = filepath.ToSlash(rel)
	runner := gitRunner{t: s.Target, path: s.WS}
	go func() {
		if _, err := runner.exec(10*time.Second, "rev-parse", "--show-toplevel"); err != nil {
			a.cx.Post(func() { a.openEditorFile(s.WS, path) })
			return
		}
		a.cx.Post(func() {
			a.showPatch(patchRequest{
				runner: runner, args: []string{"diff", "--no-color", "--", rel}, diffExit: true,
				// A file the turn created has nothing behind it to diff
				// against, so it reads as an addition.
				addedArgs: []string{"diff", "--no-index", "--no-color", "--", "/dev/null", rel},
				title:     rel, sub: "本轮改动", empty: "（这里没有可显示的差异）", failure: "无法读取改动：\n",
			})
		})
	}()
}

// patchRequest is one patch to read and show.
type patchRequest struct {
	// runner, args and addedArgs read the patch: addedArgs, when set, read
	// the file as an addition if args find nothing because it is new.
	runner    gitRunner
	args      []string
	addedArgs []string
	// diffExit withdraws exit code 1, which means the texts differ.
	diffExit bool
	timeout  time.Duration
	// title, sub and hash are what the pane says about it.
	title, sub, hash string
	// empty and failure say what the pane shows when there is no
	// difference and when the command fails.
	empty, failure string
}

// showPatch opens the diff pane and reads the patch there.
func (a *app) showPatch(req patchRequest) {
	timeout := req.timeout
	if timeout <= 0 {
		timeout = 40 * time.Second
	}
	read := func(args []string) (string, error) {
		if req.diffExit {
			return req.runner.execDiff(timeout, args...)
		}
		return req.runner.exec(timeout, args...)
	}
	a.gitDiffHash = req.hash
	a.gitDiffTitle.Set(req.title)
	a.gitDiffSub.Set(req.sub)
	a.gitDiffPatch.Set("")
	a.gitDiffLoading.Set(true)
	a.openPane(paneDiff)
	go func() {
		out, err := read(req.args)
		if err == nil && strings.TrimSpace(out) == "" && len(req.addedArgs) > 0 {
			if added, addedErr := read(req.addedArgs); addedErr == nil {
				out = added
			}
		}
		a.cx.Post(func() {
			a.gitDiffLoading.Set(false)
			switch {
			case err != nil:
				a.gitDiffPatch.Set(req.failure + err.Error())
			case strings.TrimSpace(out) == "":
				a.gitDiffPatch.Set(req.empty)
			default:
				const limit = 1_500_000
				if len(out) > limit {
					out = out[:limit] + "\n… 补丁过长，已截断"
				}
				a.gitDiffPatch.Set(out)
			}
		})
	}()
}

// gitPath is the repository the drawer is on.
func (a *app) gitPath() string {
	a.git.mu.Lock()
	defer a.git.mu.Unlock()
	return a.git.path
}
