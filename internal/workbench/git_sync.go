//go:build !js && !android && !ios

package workbench

// The Git drawer: the branch and its upstream, changed files with their
// stage, unstage and discard actions, the commit box, the history and the
// patch dialog. The repository is read by git.go; this file only draws it
// and sends the user's actions back.

import (
	"fmt"
	"strings"
	"time"

	"example.com/pideck-lite/internal/apptext"
	"github.com/nsgo-dev/nsgo/ui"
)

// gitFetch reads every remote.
func (a *app) gitFetch() {
	a.git.run("获取远程", func(g gitRunner) error {
		_, err := g.exec(180*time.Second, "fetch", "--all", "--prune")
		return err
	}, nil)
}

// gitPull brings the upstream's commits in.
func (a *app) gitPull() {
	a.git.run("拉取", func(g gitRunner) error {
		_, err := g.exec(180*time.Second, "pull")
		return err
	}, nil)
}

// gitPush sends the branch to its upstream; publish sets one first.
func (a *app) gitPush(publish bool) {
	st := a.git.state.GetUntracked()
	if st.Detached || st.Branch == "" {
		a.toast(ui.ToastWarning, "HEAD 不在分支上", "先切换到一个分支，再推送。")
		return
	}
	args := []string{"push"}
	if publish {
		args = []string{"push", "-u", "origin", st.Branch}
	}
	a.git.run("推送", func(g gitRunner) error {
		_, err := g.exec(180*time.Second, args...)
		return err
	}, nil)
}

// gitDeleteBranch deletes a local branch after asking.
func (a *app) gitDeleteBranch(name string) {
	if strings.TrimSpace(name) == "" {
		return
	}
	a.gitBranches.Set(false)
	a.askConfirm("删除分支", "本地分支「"+name+"」会被删除；已合并的提交不会丢。", "删除", func() {
		a.git.run("删除分支", func(g gitRunner) error {
			_, err := g.exec(60*time.Second, "branch", "-d", name)
			return err
		}, nil)
	})
}

// gitCheckout switches branches.
func (a *app) gitCheckout(branch string) {
	a.gitBranches.Set(false)
	st := a.git.state.GetUntracked()
	if branch == "" || branch == st.Branch {
		return
	}
	a.git.run(apptext.T("切换分支"), func(g gitRunner) error {
		_, err := g.exec(60*time.Second, "checkout", branch)
		return err
	}, nil)
}

// gitCheckoutRemote checks out a remote branch, creating the local one
// that tracks it when it does not exist.
func (a *app) gitCheckoutRemote(remote string) {
	a.gitBranches.Set(false)
	local := remote
	if i := strings.Index(remote, "/"); i >= 0 {
		local = remote[i+1:]
	}
	a.git.run(apptext.T("切换到 %s", remote), func(g gitRunner) error {
		if _, err := g.exec(60*time.Second, "switch", "--track", remote); err == nil {
			return nil
		}
		_, err := g.exec(60*time.Second, "switch", local)
		return err
	}, nil)
}

// gitDeleteRemoteBranch deletes a branch on its remote after asking.
func (a *app) gitDeleteRemoteBranch(name string) {
	name = strings.TrimSpace(name)
	remote, branch, ok := strings.Cut(name, "/")
	if !ok || remote == "" || branch == "" || branch == "HEAD" {
		return
	}
	a.askConfirm("删除远程分支", fmt.Sprintf(apptext.T("会在「%s」上删除分支「%s」，其他人也会看不到它。"), remote, branch), "删除", func() {
		a.git.run(apptext.T("删除远程分支"), func(g gitRunner) error {
			_, err := g.exec(120*time.Second, "push", remote, "--delete", branch)
			return err
		}, nil)
	})
}

// gitCreateBranch makes the named branch and checks it out.
func (a *app) gitCreateBranch() {
	name := strings.TrimSpace(a.gitNewBranchName.GetUntracked())
	if name == "" {
		a.toast(ui.ToastWarning, "分支还没有名字", "给新分支起一个名字。")
		return
	}
	a.gitNewBranchOpen.Set(false)
	a.git.run(apptext.T("新建分支"), func(g gitRunner) error {
		_, err := g.exec(60*time.Second, "checkout", "-b", name)
		return err
	}, func(err error) {
		if err == nil {
			a.gitNewBranchName.Set("")
		}
	})
}

// gitInit makes the project a repository.
func (a *app) gitInit() {
	a.git.run("初始化仓库", func(g gitRunner) error {
		_, err := g.exec(60*time.Second, "init")
		return err
	}, nil)
}

// gitStash puts every change away; gitStashPop brings the latest back.
func (a *app) gitStash() {
	a.git.run("贮藏改动", func(g gitRunner) error {
		_, err := g.exec(120*time.Second, "stash", "push", "--include-untracked", "-m", "PiDeck 自动贮藏")
		return err
	}, nil)
}

func (a *app) gitStashPop() {
	a.git.run("恢复贮藏", func(g gitRunner) error {
		_, err := g.exec(120*time.Second, "stash", "pop")
		return err
	}, nil)
}
