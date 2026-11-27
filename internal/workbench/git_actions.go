//go:build !js && !android && !ios

package workbench

// The Git drawer: the branch and its upstream, changed files with their
// stage, unstage and discard actions, the commit box, the history and the
// patch dialog. The repository is read by git.go; this file only draws it
// and sends the user's actions back.

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/ui"
)

// openGit shows the Git drawer, or hides it when it is already in front.
func (a *app) openGit() {
	if a.drawer.GetUntracked() && a.drawerTab.GetUntracked() == "git" {
		a.drawer.Set(false)
		a.remember()
		return
	}
	if !a.drawer.GetUntracked() || a.drawerTab.GetUntracked() != "git" {
		a.animateNextLayout()
	}
	a.drawer.Set(true)
	a.setDrawerTab("git")
	a.gitAttach()
	a.remember()
}

// openGitFor shows the Git drawer on one project.
func (a *app) openGitFor(ws *workspace) {
	a.activeWS.Set(projectWireKey(ws))
	if !a.drawer.GetUntracked() || a.drawerTab.GetUntracked() != "git" {
		a.animateNextLayout()
	}
	a.drawer.Set(true)
	a.setDrawerTab("git")
	a.git.attach(ws)
	a.remember()
}

// gitAttach points the drawer at the active project, rereading it when it
// stays the same.
func (a *app) gitAttach() {
	if !a.git.attach(a.activeWorkspace()) {
		a.git.refreshAll()
	}
}

// gitChangesView is how the changes are listed: the stored choice, or the
// flat list, which fits more paths in the drawer, when the config does not
// name one.
func (a *app) gitChangesView() string {
	if a.cfg.GitChangesView == gitViewTree {
		return gitViewTree
	}
	return gitViewFlat
}

// setGitChangesView switches between the tree and the flat list, and keeps
// the choice.
func (a *app) setGitChangesView(view string) {
	if view != gitViewFlat {
		view = gitViewTree
	}
	if a.git.view.GetUntracked() == view {
		return
	}
	a.git.view.Set(view)
	a.cfg.GitChangesView = view
	if a.st != nil {
		a.st.edit(func(c *config) { c.GitChangesView = view })
	}
}

// toggleGitFolder folds or opens one folder of the changes tree.
func (a *app) toggleGitFolder(path string) {
	a.git.collapsed.Update(func(folded map[string]bool) map[string]bool {
		out := make(map[string]bool, len(folded)+1)
		for k, v := range folded {
			out[k] = v
		}
		if out[path] {
			delete(out, path)
		} else {
			out[path] = true
		}
		return out
	})
}

// showAllGitFiles lifts the changes list's row limit.
func (a *app) showAllGitFiles() { a.git.filesShown.Set(gitFilesAll) }

// collapseGitFiles puts the changes list back to its first page.
func (a *app) collapseGitFiles() { a.git.filesShown.Set(gitFilesShown) }

// moreGitHistory shows another page of commits, reading more from the
// repository when the loaded ones run out.
func (a *app) moreGitHistory() {
	st := a.git.state.GetUntracked()
	shown := a.git.historyShown.GetUntracked() + gitHistoryPage
	a.git.historyShown.Set(shown)
	if shown >= len(st.Commits) && st.LogLimit > 0 && len(st.Commits) >= st.LogLimit {
		a.git.loadMore()
	}
}

// setGitLogQuery debounces the filter. The query is answered from the whole
// history rather than the page the drawer has read, so it runs git off the
// UI thread and waits for typing to pause.
func (a *app) setGitLogQuery(q string) {
	a.git.logQuery.Set(q)
	a.stopGitSearchTimer()
	query := strings.TrimSpace(q)
	if query == "" {
		a.git.logSearch.Set(nil)
		return
	}
	a.git.logSearch.Set(&gitSearch{Query: query, Loading: true})
	a.git.searchTimer = a.cx.AfterFunc(gitSearchDebounce, a.runGitLogSearch)
}

// stopGitSearchTimer drops a debounce that has not fired yet.
func (a *app) stopGitSearchTimer() {
	if a.git.searchTimer != nil {
		a.git.searchTimer()
		a.git.searchTimer = nil
	}
}

// runGitLogSearch reads the query's matches off the UI thread. A search that
// is already running answers the latest query once it lands.
func (a *app) runGitLogSearch() {
	a.stopGitSearchTimer()
	query := strings.TrimSpace(a.git.logQuery.GetUntracked())
	t, path := a.git.repo()
	if query == "" || path == "" {
		return
	}
	if a.git.searching {
		a.git.searchPending = true
		return
	}
	a.git.searching = true
	limit, seq := a.git.searchLimit.GetUntracked(), a.git.seq
	go func() {
		commits, err := searchCommits(t, path, query, limit)
		a.cx.Post(func() {
			a.git.searching = false
			if seq == a.git.seq && strings.TrimSpace(a.git.logQuery.GetUntracked()) == query {
				res := &gitSearch{Query: query, Commits: commits}
				if err != nil {
					res.Error = err.Error()
				}
				a.git.logSearch.Set(res)
			}
			if a.git.searchPending {
				a.git.searchPending = false
				a.runGitLogSearch()
			}
		})
	}()
}

// moreGitSearch asks for another page of matches.
func (a *app) moreGitSearch() {
	a.git.searchLimit.Update(func(n int) int { return n + gitSearchPage })
	a.runGitLogSearch()
}

// openGitSourceFile shows a changed path itself in the editor. The path is
// relative to the repository root, which can sit above the workspace.
func (a *app) openGitSourceFile(f gitFile) {
	root := a.git.state.GetUntracked().Root
	if root == "" {
		root = a.gitPath()
	}
	if root == "" {
		return
	}
	a.openEditorFile(root, filepath.Join(root, filepath.FromSlash(f.Path)))
}

// gitStageFile stages one path.
func (a *app) gitStageFile(f gitFile) {
	a.git.run("暂存", func(g gitRunner) error {
		_, err := g.exec(30*time.Second, "add", "--", f.Path)
		return err
	}, nil)
}

// gitStageAll stages every change.
func (a *app) gitStageAll() {
	a.git.run("暂存全部", func(g gitRunner) error {
		_, err := g.exec(60*time.Second, "add", "-A")
		return err
	}, nil)
}

// gitUnstagePaths removes paths from the index, with the fallback an
// unborn branch needs.
func (a *app) gitUnstagePaths(paths ...string) {
	initial := a.git.state.GetUntracked().Initial
	a.git.run("取消暂存", func(g gitRunner) error {
		args := append([]string{"restore", "--staged", "--"}, paths...)
		_, err := g.exec(30*time.Second, args...)
		if err == nil {
			return nil
		}
		if !initial {
			return err
		}
		fallback := append([]string{"rm", "--cached", "-r", "-q", "--"}, paths...)
		if _, err2 := g.exec(30*time.Second, fallback...); err2 == nil {
			return nil
		}
		return err
	}, nil)
}

// gitUnstageFile removes one path from the index.
func (a *app) gitUnstageFile(f gitFile) { a.gitUnstagePaths(f.Path) }

// gitUnstageAll empties the index.
func (a *app) gitUnstageAll() { a.gitUnstagePaths(".") }

// gitDiscardFile asks, then restores a path to its committed state.
func (a *app) gitDiscardFile(f gitFile) {
	a.askConfirm("丢弃更改", "丢弃「"+f.Path+"」的所有改动？这一步不能撤销。", "丢弃", func() {
		initial := a.git.state.GetUntracked().Initial
		a.git.run("丢弃改动", func(g gitRunner) error {
			if f.Untracked {
				_, err := g.exec(30*time.Second, "clean", "-f", "-d", "--", f.Path)
				return err
			}
			if initial {
				// An unborn branch has no HEAD: take the path out of the
				// index, then delete what is left.
				if _, err := g.exec(30*time.Second, "rm", "--cached", "-r", "-q", "--", f.Path); err != nil {
					return err
				}
				_, err := g.exec(30*time.Second, "clean", "-f", "--", f.Path)
				return err
			}
			if _, err := g.exec(30*time.Second, "restore", "--staged", "--worktree", "--", f.Path); err != nil {
				// Older git has no restore; checkout from HEAD does the
				// same for a tracked path.
				if _, err = g.exec(30*time.Second, "checkout", "HEAD", "--", f.Path); err != nil {
					return err
				}
			}
			return nil
		}, nil)
	})
}

// gitResolveConflict keeps one side of a conflict and stages the result.
func (a *app) gitResolveConflict(f gitFile, side string) {
	if !f.Conflicted {
		return
	}
	label := "用我的版本"
	if side == "theirs" {
		label = "用对方版本"
	}
	a.git.run(label, func(g gitRunner) error {
		if _, err := g.exec(60*time.Second, "checkout", "--"+side, "--", f.Path); err != nil {
			return err
		}
		_, err := g.exec(60*time.Second, "add", "--", f.Path)
		return err
	}, nil)
}

// gitAbortOperation abandons a merge, rebase or cherry-pick in progress.
func (a *app) gitAbortOperation() {
	a.askConfirm("中止这次合并", "回到操作前的状态；已经手动改好的冲突内容不会保留。", "中止", func() {
		a.git.run("中止合并", func(g gitRunner) error {
			if _, err := g.exec(60*time.Second, "merge", "--abort"); err == nil {
				return nil
			}
			if _, err := g.exec(60*time.Second, "rebase", "--abort"); err == nil {
				return nil
			}
			if _, err := g.exec(60*time.Second, "cherry-pick", "--abort"); err == nil {
				return nil
			}
			return errors.New("没有进行中的合并、变基或挑拣")
		}, nil)
	})
}

// gitMarkResolved stages a conflict's file as it stands.
func (a *app) gitMarkResolved(f gitFile) {
	if !f.Conflicted {
		return
	}
	a.git.run("标记已解决", func(g gitRunner) error {
		_, err := g.exec(60*time.Second, "add", "--", f.Path)
		return err
	}, nil)
}

// gitResetLast moves the last commit's changes back to the index, keeping
// the files as they are.
func (a *app) gitResetLast() {
	st := a.git.state.GetUntracked()
	if st.Initial || st.OID == "" {
		a.toast(ui.ToastInfo, "还没有提交", "第一次提交之前没有可撤销的提交。")
		return
	}
	a.askConfirm("撤销上次提交", "把上一次提交放回暂存区（git reset --soft HEAD~1），文件内容不变。", "撤销", func() {
		a.git.run("撤销上次提交", func(g gitRunner) error {
			_, err := g.exec(60*time.Second, "reset", "--soft", "HEAD~1")
			return err
		}, nil)
	})
}

// openUnpushedCommits lists what the upstream branch does not have yet.
func (a *app) openUnpushedCommits() {
	st := a.git.state.GetUntracked()
	if st.Upstream == "" {
		a.toast(ui.ToastInfo, "没有上游分支", "先发布到远端，才能看未推送的提交。")
		return
	}
	t, path := a.git.repo()
	if path == "" {
		return
	}
	a.gitUnpushed = nil
	a.gitUnpushedErr.Set("")
	a.gitUnpushedOpen.Set(true)
	a.gitUnpushedRev.Update(func(n int) int { return n + 1 })
	go func() {
		commits, err := readUnpushedCommits(t, path)
		a.cx.Post(func() {
			if err != nil {
				a.gitUnpushedErr.Set(err.Error())
			}
			a.gitUnpushed = commits
			a.gitUnpushedRev.Update(func(n int) int { return n + 1 })
		})
	}()
}

// openBlame attributes a file's lines to commits.
func (a *app) openBlame(path string) {
	path = strings.TrimSpace(path)
	if path == "" {
		return
	}
	t, dir := a.git.repo()
	if dir == "" {
		return
	}
	a.gitBlamePath.Set(path)
	a.gitBlame = nil
	a.gitBlameErr.Set("")
	a.openPane(paneBlame)
	a.gitBlameRev.Update(func(n int) int { return n + 1 })
	go func() {
		ranges, err := readFileBlame(t, dir, path)
		a.cx.Post(func() {
			if err != nil {
				a.gitBlameErr.Set(err.Error())
			}
			a.gitBlame = ranges
			a.gitBlameRev.Update(func(n int) int { return n + 1 })
		})
	}()
}

// openFileHistory lists the commits that touched one path.
func (a *app) openFileHistory(path string) {
	path = strings.TrimSpace(path)
	if path == "" {
		return
	}
	t, dir := a.git.repo()
	if dir == "" {
		return
	}
	a.gitFileHistoryPath.Set(path)
	a.gitFileHistory = nil
	a.gitFileHistoryErr.Set("")
	a.openPane(paneFileHistory)
	a.gitFileHistoryRev.Update(func(n int) int { return n + 1 })
	go func() {
		commits, err := readFileHistory(t, dir, path, 50)
		a.cx.Post(func() {
			if err != nil {
				a.gitFileHistoryErr.Set(err.Error())
			}
			a.gitFileHistory = commits
			a.gitFileHistoryRev.Update(func(n int) int { return n + 1 })
		})
	}()
}

// gitDiscardAll asks, then restores every path and removes untracked ones.
func (a *app) gitDiscardAll() {
	st := a.git.state.GetUntracked()
	if len(st.Files) == 0 {
		return
	}
	a.askConfirm("丢弃全部更改", "丢弃这个项目里所有未提交的改动？未跟踪的文件也会被删除，这一步不能撤销。", "全部丢弃", func() {
		initial := st.Initial
		a.git.run("丢弃全部", func(g gitRunner) error {
			if initial {
				if _, err := g.exec(60*time.Second, "rm", "--cached", "-r", "-q", "--", "."); err != nil {
					return err
				}
			} else if _, err := g.exec(60*time.Second, "restore", "--staged", "--worktree", "--", "."); err != nil {
				if _, err = g.exec(60*time.Second, "checkout", "HEAD", "--", "."); err != nil {
					return err
				}
			}
			_, err := g.exec(60*time.Second, "clean", "-f", "-d", "--", ".")
			return err
		}, nil)
	})
}

// gitCommit commits the staged changes, or all of them, with the box's
// message.
func (a *app) gitCommit(all, amend bool) { a.gitCommitPush(all, amend, false) }

// gitCommitAndPush commits and pushes in one step.
func (a *app) gitCommitAndPush() { a.gitCommitPush(false, a.git.amend.Get(), true) }

// gitCommitPush commits, optionally pushing what the commit left to send.
func (a *app) gitCommitPush(all, amend, push bool) {
	msg := strings.TrimSpace(a.git.msg.GetUntracked())
	if msg == "" {
		a.toast(ui.ToastWarning, "还差提交说明", "写一句话，再把改动提交。")
		return
	}
	st := a.git.state.GetUntracked()
	if !st.IsRepo {
		return
	}
	if push && st.Upstream == "" {
		a.toast(ui.ToastInfo, "没有上游分支", "先发布到 origin，才能提交并推送。")
		return
	}
	if !all && !amend && st.stagedCount() == 0 {
		a.toast(ui.ToastInfo, "没有已暂存的改动", "先用 + 暂存文件，或者直接「全部提交」。")
		return
	}
	label := apptext.T("提交")
	if push {
		label = apptext.T("提交并推送")
	}
	// The toast repeats what was committed, so the box clearing itself
	// does not leave the user wondering what went in.
	subject := viewkit.FirstLine(msg, 90)
	a.git.runDetail(label, func(g gitRunner) (string, error) {
		if all {
			if _, err := g.exec(60*time.Second, "add", "-A"); err != nil {
				return "", err
			}
		}
		args := []string{"commit"}
		if amend {
			args = append(args, "--amend")
		}
		args = append(args, "-m", msg)
		if _, err := g.exec(180*time.Second, args...); err != nil {
			return "", err
		}
		if push {
			if _, err := g.exec(180*time.Second, "push"); err != nil {
				return "", errors.New("已经提交，但推送失败：" + err.Error())
			}
		}
		return subject, nil
	}, func(err error) {
		if err == nil {
			a.git.msg.Set("")
			a.git.amend.Set(false)
			a.emit(eventGitCommit, appEvent{Data: map[string]string{"message": msg, "amend": fmt.Sprintf("%t", amend)}})
		}
	})
}
