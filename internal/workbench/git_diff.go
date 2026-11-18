//go:build !js && !android && !ios

package workbench

// The Git drawer: the branch and its upstream, changed files with their
// stage, unstage and discard actions, the commit box, the history and the
// patch dialog. The repository is read by git.go; this file only draws it
// and sends the user's actions back.

import (
	"strings"
	"time"
)

// gitShowFileDiff opens a file's patch in the dialog.
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
	a.gitDiffHash = ""
	a.gitDiffTitle.Set(f.Path)
	a.gitDiffSub.Set(sub)
	a.gitDiffPatch.Set("")
	a.gitDiffLoading.Set(true)
	a.gitDiffOpen.Set(true)
	runner := a.git.runner()
	go func() {
		var args []string
		switch {
		case f.Untracked:
			// An untracked file has nothing to diff against but emptiness.
			args = []string{"diff", "--no-index", "--no-color", "--", "/dev/null", f.Path}
		case staged:
			args = []string{"diff", "--cached", "--no-color", "--", f.Path}
		default:
			args = []string{"diff", "--no-color", "--", f.Path}
		}
		out, err := runner.execDiff(40*time.Second, args...)
		a.cx.Post(func() {
			a.gitDiffLoading.Set(false)
			switch {
			case err != nil:
				a.gitDiffPatch.Set("无法读取改动：\n" + err.Error())
			case strings.TrimSpace(out) == "":
				a.gitDiffPatch.Set("（这里没有可显示的差异）")
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

// gitShowCommit opens a commit's patch in the dialog.
func (a *app) gitShowCommit(c gitCommit) {
	if a.gitPath() == "" {
		return
	}
	a.gitDiffHash = c.Hash
	a.gitDiffTitle.Set(c.Short + " · " + c.Subject)
	sub := c.Author
	if !c.Date.IsZero() {
		sub += " · " + c.Date.Format("2006-01-02 15:04")
	}
	a.gitDiffSub.Set(sub)
	a.gitDiffPatch.Set("")
	a.gitDiffLoading.Set(true)
	a.gitDiffOpen.Set(true)
	runner := a.git.runner()
	go func() {
		out, err := runner.exec(60*time.Second, "--no-pager", "show", "--no-color", "--format=fuller", "--patch", c.Hash)
		a.cx.Post(func() {
			a.gitDiffLoading.Set(false)
			switch {
			case err != nil:
				a.gitDiffPatch.Set("无法读取提交：\n" + err.Error())
			case strings.TrimSpace(out) == "":
				a.gitDiffPatch.Set("（这次提交没有可显示的差异）")
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
