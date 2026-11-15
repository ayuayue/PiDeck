package main

// The Git drawer: the branch and its upstream, changed files with their
// stage, unstage and discard actions, the commit box, the history and the
// patch dialog. The repository is read by git.go; this file only draws it
// and sends the user's actions back.

import (
	"fmt"
	"path"
	"strings"
	"time"

	"github.com/oneo-me/nsgo/base"
	"github.com/oneo-me/nsgo/core"
	"github.com/oneo-me/nsgo/icons/lucide"
	"github.com/oneo-me/nsgo/ui"
	uidiff "github.com/oneo-me/nsgo/ui/diff"
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
	a.drawerTab.Set("git")
	a.gitAttach()
	a.remember()
}

// openGitFor shows the Git drawer on one project.
func (a *app) openGitFor(ws *workspace) {
	if !a.drawer.GetUntracked() || a.drawerTab.GetUntracked() != "git" {
		a.animateNextLayout()
	}
	a.drawer.Set(true)
	a.drawerTab.Set("git")
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

// --- actions ------------------------------------------------------------

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
func (a *app) gitCommit(all, amend bool) {
	msg := strings.TrimSpace(a.git.msg.GetUntracked())
	if msg == "" {
		a.toast(ui.ToastWarning, "还差提交说明", "写一句话，再把改动提交。")
		return
	}
	st := a.git.state.GetUntracked()
	if !st.IsRepo {
		return
	}
	if !all && !amend && st.stagedCount() == 0 {
		a.toast(ui.ToastInfo, "没有已暂存的改动", "先用 + 暂存文件，或者直接「全部提交」。")
		return
	}
	a.git.run(T("提交"), func(g gitRunner) error {
		if all {
			if _, err := g.exec(60*time.Second, "add", "-A"); err != nil {
				return err
			}
		}
		args := []string{"commit"}
		if amend {
			args = append(args, "--amend")
		}
		args = append(args, "-m", msg)
		_, err := g.exec(180*time.Second, args...)
		return err
	}, func(err error) {
		if err == nil {
			a.git.msg.Set("")
			a.git.amend.Set(false)
			a.emit(eventGitCommit, appEvent{Data: map[string]string{"message": msg, "amend": fmt.Sprintf("%t", amend)}})
		}
	})
}

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
	a.git.run(T("切换分支"), func(g gitRunner) error {
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
	a.git.run(T("切换到 %s", remote), func(g gitRunner) error {
		if _, err := g.exec(60*time.Second, "switch", "--track", remote); err == nil {
			return nil
		}
		_, err := g.exec(60*time.Second, "switch", local)
		return err
	}, nil)
}

// gitCreateBranch makes the named branch and checks it out.
func (a *app) gitCreateBranch() {
	name := strings.TrimSpace(a.gitNewBranchName.GetUntracked())
	if name == "" {
		a.toast(ui.ToastWarning, "分支还没有名字", "给新分支起一个名字。")
		return
	}
	a.gitNewBranchOpen.Set(false)
	a.git.run(T(T("新建分支")), func(g gitRunner) error {
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

// --- drawer -------------------------------------------------------------

// drawerGit draws the repository in the right drawer.
func (a *app) drawerGit() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		st := a.git.state.Get()
		if a.gitPath() == "" {
			return gitEmpty(colors, T("先打开一个项目"), T("Git 面板显示当前项目的分支、改动与历史。"))
		}
		if !st.Checked && st.Loading {
			return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 8},
				Children: []core.Node{ui.Spinner{Size: 16, Label: "读取 Git 仓库"}, ui.Text(T("正在读取仓库…"), 12, ui.Regular, colors.Muted)}}
		}
		if st.NotRepo {
			return a.gitNotRepo(cx, st)
		}
		if !st.IsRepo && st.Error != "" {
			return core.View{Style: core.Style{Gap: 10, Padding: core.All(16)}, Children: []core.Node{
				ui.Text(T("无法读取 Git 仓库"), 13, ui.Semibold, colors.Danger),
				core.Text{Content: st.Error, Style: core.Style{FontSize: 11.5, LineHeight: 17}, StyleFunc: ui.Colored(colors.Muted)},
				ui.Button{Text: T("重试"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, OnPress: func() { a.git.refreshAll() }},
			}}
		}
		return core.View{Style: core.Style{FlexGrow: 1, MinHeight: core.Pt(0), MinWidth: core.Pt(0), Gap: 10}, Children: []core.Node{
			a.gitHeader(cx, st),
			core.Show{When: func() bool { return st.Error != "" }, Then: func(cx *core.Scope) core.Node {
				return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					ui.Icon(lucide.TriangleAlert, 12, colors.Danger),
					core.Text{Content: st.Error, MaxLines: 3, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 10.5, LineHeight: 15},
						StyleFunc: ui.Colored(colors.Danger)},
					ui.Button{Text: T("重试"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.git.refreshAll() }},
				}}
			}},
			core.Show{When: func() bool { return a.git.err.Get() != "" }, Then: func(cx *core.Scope) core.Node { return a.gitError(cx) }},
			core.Scroll{Style: ui.FillRest, Children: []core.Node{
				core.View{Style: core.Style{Gap: 12, Padding: core.Edges{Top: 2, Bottom: 20, Right: 2, Left: 2}}, Children: []core.Node{
					a.gitChanges(cx, st),
					a.gitCommitBox(cx, st),
					a.gitHistory(cx, st),
					core.Text{ContentFunc: func() string {
						if st.Root == "" {
							return shortPath(a.gitPath(), 48)
						}
						return shortPath(st.Root, 48)
					}, MaxLines: 2, EllipsizeMode: core.EllipsizeMiddle,
						Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5, LineHeight: 14}, StyleFunc: ui.Colored(colors.Faint)},
				}},
			}},
		}}
	})
}

// gitEmpty is the drawer's empty state.
func gitEmpty(colors ui.Colors, title, note string) core.Node {
	return core.View{Style: core.Style{FlexGrow: 1, Padding: core.All(18), Gap: 6}, Children: []core.Node{
		ui.Text(title, 13, ui.Semibold, colors.Text),
		core.Text{Content: note, Style: core.Style{FontSize: 11.5, LineHeight: 17}, StyleFunc: ui.Colored(colors.Muted)},
	}}
}

// gitNotRepo asks to initialize the folder.
func (a *app) gitNotRepo(cx *core.Scope, st gitState) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{Style: core.Style{FlexGrow: 1, Padding: core.All(18), Gap: 9, AlignItems: core.AlignStart}, Children: []core.Node{
		ui.Icon(lucide.FolderGit, 22, colors.Faint),
		ui.Text(T("这个项目还不是 Git 仓库"), 13, ui.Semibold, colors.Text),
		core.Text{ContentFunc: a.gitPath, MaxLines: 3, EllipsizeMode: core.EllipsizeMiddle,
			Style: core.Style{FontFamily: ui.Mono, FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
		ui.Button{Text: T("初始化 Git 仓库"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, OnPress: a.gitInit},
		core.Show{When: func() bool { return st.Error != "" }, Then: func(cx *core.Scope) core.Node {
			return core.Text{Content: st.Error, Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Danger)}
		}},
	}}
}

// gitHeader is the branch, its upstream, and the sync buttons.
func (a *app) gitHeader(cx *core.Scope, st gitState) core.Node {
	colors := ui.ColorsOf(cx)
	branch := st.Branch
	if branch == "" {
		branch = "HEAD"
	}
	if st.Detached {
		short := st.OID
		if len(short) > 7 {
			short = short[:7]
		}
		branch = "HEAD · " + short
	}
	trigger := core.Dynamic(func(cx *core.Scope) core.Node {
		children := []core.Node{
			ui.Icon(lucide.GitBranch, 13, colors.Muted),
			core.Text{ContentFunc: func() string {
				if st.Detached {
					short := st.OID
					if len(short) > 7 {
						short = short[:7]
					}
					return "HEAD · " + short
				}
				if st.Branch == "" {
					return T("分支")
				}
				return st.Branch
			}, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style: core.Style{FontSize: 12.5, FontWeight: ui.Semibold, MinWidth: core.Pt(0), FlexShrink: 1}, StyleFunc: ui.Colored(colors.Text)},
			ui.Icon(lucide.ChevronDown, 10, colors.Faint),
		}
		if st.Ahead > 0 {
			children = append(children, gitSyncChip(colors, fmt.Sprintf("↑%d", st.Ahead), colors.Up()))
		}
		if st.Behind > 0 {
			children = append(children, gitSyncChip(colors, fmt.Sprintf("↓%d", st.Behind), colors.Down()))
		}
		return core.View{OnPress: func(core.PressEvent) {
			a.gitBranches.Update(func(v bool) bool { return !v })
			if a.gitBranches.GetUntracked() {
				a.git.refreshAll()
			}
		}, Role: core.RoleButton, Label: T("切换分支"), TestID: "git-branch",
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Height: core.Pt(26), MinWidth: core.Pt(0),
					Padding: core.Symmetric(0, 6), CornerRadius: 6, Transition: pressMotion,
					Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
			}, Children: children}
	})
	branchMenu := a.popoverCard(a.gitBranches, core.PlaceBottom, core.AlignStart, 246, trigger, func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		var rows []core.Node
		for _, name := range st.Branches {
			b := name
			current := b == st.Branch
			children := []core.Node{
				core.View{Style: core.Style{Width: core.Pt(14), AlignItems: core.AlignCenter}, Children: []core.Node{
					core.Show{When: func() bool { return current }, Then: func(*core.Scope) core.Node { return ui.Icon(lucide.Check, 12, colors.Text) }},
				}},
				core.Text{Content: b, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
					Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12}, StyleFunc: ui.Colored(colors.Text)},
			}
			if !current {
				children = append(children, core.View{OnPress: func(core.PressEvent) { a.gitDeleteBranch(b) },
					Role: core.RoleButton, Label: T("删除分支") + " " + b, TestID: "git-branch-delete-" + b,
					StyleFunc: func() core.Style {
						return core.Style{Width: core.Pt(20), Height: core.Pt(20), CornerRadius: 5, AlignItems: core.AlignCenter,
							JustifyContent: core.JustifyCenter, Hover: &core.Style{Background: colors.Pressed()}}
					},
					Children: []core.Node{ui.Icon(lucide.Trash, 10, colors.Faint)}})
			}
			rows = append(rows, core.View{
				OnPress: func(core.PressEvent) { a.gitCheckout(b) },
				Role:    core.RoleOption, Label: b,
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Height: core.Pt(28),
						Padding: core.Symmetric(0, 8), CornerRadius: 6, Transition: pressMotion,
						Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
				},
				Children: children,
			})
		}
		if len(rows) == 0 {
			rows = append(rows, core.Text{Content: T("没有本地分支"), Style: core.Style{FontSize: 11.5, Padding: core.All(8)},
				StyleFunc: ui.Colored(colors.Faint)})
		}
		if len(st.RemoteBranches) > 0 {
			rows = append(rows, core.View{Style: core.Style{Height: core.Pt(1), Margin: core.Symmetric(4, 4)}, StyleFunc: ui.Filled(colors.Line)})
			rows = append(rows, core.Text{Content: T("远程分支"), Style: core.Style{FontFamily: ui.Mono, FontSize: 9,
				Padding: core.Edges{Left: 8, Top: 4, Bottom: 2}}, StyleFunc: ui.Colored(colors.Faint)})
			for _, name := range st.RemoteBranches {
				b := name
				rows = append(rows, core.View{
					OnPress: func(core.PressEvent) { a.gitCheckoutRemote(b) },
					Role:    core.RoleOption, Label: b,
					StyleFunc: func() core.Style {
						return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Height: core.Pt(28),
							Padding: core.Symmetric(0, 8), CornerRadius: 6, Transition: pressMotion,
							Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
					},
					Children: []core.Node{
						core.View{Style: core.Style{Width: core.Pt(14), AlignItems: core.AlignCenter},
							Children: []core.Node{ui.Icon(lucide.Cloud, 11, colors.Faint)}},
						core.Text{Content: b, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12}, StyleFunc: ui.Colored(colors.Muted)},
					},
				})
			}
		}
		rows = append(rows, core.View{Style: core.Style{Height: core.Pt(1), Margin: core.Symmetric(4, 4)}, StyleFunc: ui.Filled(colors.Line)})
		rows = append(rows, core.View{
			OnPress: func(core.PressEvent) {
				a.gitBranches.Set(false)
				a.gitNewBranchName.Set("")
				a.gitNewBranchOpen.Set(true)
			},
			Role: core.RoleButton, Label: T(T("新建分支")),
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Height: core.Pt(28),
					Padding: core.Symmetric(0, 8), CornerRadius: 6, Transition: pressMotion,
					Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
			},
			Children: []core.Node{
				ui.Icon(lucide.GitBranchPlus, 13, colors.Muted),
				ui.Text(T("新建分支…"), 12, ui.Regular, colors.Text),
			},
		})
		return core.Scroll{Style: core.Style{MaxHeight: core.Pt(360), Width: core.Pt(234)}, Children: []core.Node{
			core.View{Style: core.Style{Gap: 1, MinWidth: core.Pt(0)}, Children: rows}}}
	}, "git-branches-menu")

	return core.View{Style: core.Style{Gap: 6, FlexShrink: 0}, Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4}, Children: []core.Node{
			branchMenu,
			core.View{Style: core.Style{FlexGrow: 1}},
			core.Dynamic(func(*core.Scope) core.Node {
				if busy := a.git.busy.Get(); busy != "" {
					return ui.Spinner{Size: 12, Label: busy}
				}
				return nil
			}),
			a.pressIcon(lucide.CloudDownload, T("获取远程（fetch）"), 24, 13,
				func() bool { return a.git.busy.Get() != "" }, a.gitFetch, ""),
			a.pressIcon(lucide.ArrowDownToLine, T("拉取（pull）"), 24, 13,
				func() bool { return a.git.busy.Get() != "" }, a.gitPull, ""),
			a.pressIcon(lucide.ArrowUpFromLine, T("推送（push）"), 24, 13,
				func() bool { return a.git.busy.Get() != "" }, func() { a.gitPush(false) }, ""),
			a.pressIcon(lucide.RefreshCw, T("刷新 Git"), 24, 12.5,
				func() bool { return a.git.busy.Get() != "" }, func() { a.git.refreshAll() }, ""),
			ui.ContextMenu{Open: a.gitMoreOpen.Get,
				OnOpenChange: func(open bool, _ base.Reason) { a.gitMoreOpen.Set(open) },
				Trigger: a.pressIcon(lucide.Ellipsis, T("更多 Git 操作"), 24, 14, nil,
					func() { a.gitMoreOpen.Update(func(v bool) bool { return !v }) }, "git-more"),
				TestID: "git-more-menu", Children: []core.Node{
					ui.MenuItem{Text: T("远端…"), Icon: lucide.Cloud, OnSelect: a.openGitRemotes},
					ui.MenuItem{Text: T("标签…"), Icon: lucide.Tag, OnSelect: a.openGitTags},
					ui.MenuItem{Text: T("未推送的提交…"), Icon: lucide.CloudUpload, OnSelect: a.openUnpushedCommits},
					ui.MenuItem{Text: T("撤销上次提交…"), Icon: lucide.Undo2, Variant: ui.MenuItemDanger, OnSelect: a.gitResetLast},
					ui.MenuItem{Text: T("贮藏列表…"), Icon: lucide.Archive, OnSelect: a.openGitStashList},
					ui.MenuItem{Text: T("贮藏全部改动"), Icon: lucide.Archive, OnSelect: a.gitStash},
					ui.MenuItem{Text: T("恢复最近贮藏"), Icon: lucide.ArchiveRestore, OnSelect: a.gitStashPop},
					ui.MenuItem{Text: T("丢弃全部改动"), Icon: lucide.Undo2, Variant: ui.MenuItemDanger, OnSelect: a.gitDiscardAll},
					ui.MenuItem{Text: T("初始化 Git 仓库"), Icon: lucide.FolderGit, OnSelect: a.gitInit},
				}},
		}},
		core.Dynamic(func(*core.Scope) core.Node {
			if st.Upstream == "" {
				if st.Initial || st.Detached || st.Branch == "" {
					return nil
				}
				return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					ui.Icon(lucide.Cloud, 11, colors.Faint),
					ui.Text(T("这个分支还没有上游"), 10.5, ui.Regular, colors.Faint),
					ui.Button{Text: T("发布到 origin"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, OnPress: func() { a.gitPush(true) }},
				}}
			}
			return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5}, Children: []core.Node{
				ui.Icon(lucide.Cloud, 11, colors.Faint),
				core.Text{Content: st.Upstream, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
					Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5, FlexShrink: 1, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Faint)},
			}}
		}),
	}}
}

// gitSyncChip is a small ahead/behind count.
func gitSyncChip(colors ui.Colors, text string, tone core.Color) core.Node {
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Height: core.Pt(16),
		Padding: core.Symmetric(0, 4), CornerRadius: 4, Background: ui.Alpha(tone, 0.10)},
		Children: []core.Node{ui.Text(text, 9, ui.Medium, func() core.Color { return tone })}}
}

// gitError is the last action's failure, dismissible.
func (a *app) gitError(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	return core.View{StyleFunc: func() core.Style {
		return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Padding: core.Symmetric(6, 8), CornerRadius: 6,
			Background: ui.Alpha(colors.Danger(), 0.08)}
	}, Children: []core.Node{
		ui.Icon(lucide.TriangleAlert, 12, colors.Danger),
		core.Text{ContentFunc: a.git.err.Get, MaxLines: 3, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11, LineHeight: 16},
			StyleFunc: ui.Colored(colors.Danger)},
		core.View{OnPress: func(core.PressEvent) { a.git.err.Set("") }, Role: core.RoleButton, Label: "关闭错误",
			StyleFunc: func() core.Style {
				return core.Style{Width: core.Pt(18), Height: core.Pt(18), AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
					CornerRadius: 4, Hover: &core.Style{Background: colors.Hover()}}
			}, Children: []core.Node{ui.Icon(lucide.X, 10, colors.Danger)}},
	}}
}

// gitChanges lists the staged and unstaged files.
func (a *app) gitChanges(cx *core.Scope, st gitState) core.Node {
	colors := ui.ColorsOf(cx)
	var staged, unstaged []gitFile
	for _, f := range st.Files {
		if f.staged() {
			staged = append(staged, f)
		}
		if f.unstaged() {
			unstaged = append(unstaged, f)
		}
	}
	row := func(title, count string, actions ...core.Node) core.Node {
		children := []core.Node{
			core.Text{Content: title, Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5, LetterSpacing: 0.5}, StyleFunc: ui.Colored(colors.Faint)},
			core.Text{Content: count, Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
			core.View{Style: core.Style{FlexGrow: 1}},
		}
		children = append(children, actions...)
		return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, MinHeight: core.Pt(22)}, Children: children}
	}
	var body []core.Node
	if conflicts := st.conflicts(); len(conflicts) > 0 {
		body = append(body, core.View{
			OnPress: func(core.PressEvent) { a.gitConflictsOpen.Set(true) },
			Role:    core.RoleButton, Label: T("%d 个文件有冲突", len(conflicts)), TestID: "git-conflicts",
			StyleFunc: func() core.Style {
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, MinHeight: core.Pt(30),
					Padding: core.Symmetric(0, 8), CornerRadius: 7, Background: ui.Alpha(colors.Danger(), 0.10),
					BorderWidth: 1, BorderColor: ui.Alpha(colors.Danger(), 0.28), Transition: pressMotion,
					Hover: &core.Style{Background: ui.Alpha(colors.Danger(), 0.16)}}
			},
			Children: []core.Node{
				ui.Icon(lucide.TriangleAlert, 12, colors.Danger),
				core.Text{Content: T("%d 个文件有冲突", len(conflicts)), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 11, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}, StyleFunc: ui.Colored(colors.Danger)},
				ui.Text(T("解决…"), 10.5, ui.Medium, colors.Danger),
			}})
	}
	body = append(body, row(T("已暂存"), fmt.Sprint(len(staged)),
		a.pressIcon(lucide.Minus, "取消暂存全部", 21, 11,
			func() bool { return len(staged) == 0 || a.git.busy.Get() != "" }, a.gitUnstageAll, "")))
	for _, f := range staged {
		body = append(body, a.gitFileRow(cx, f, true))
	}
	if len(staged) == 0 {
		body = append(body, core.Text{Content: T("还没有暂存的改动"), Style: core.Style{FontSize: 10.5, Padding: core.Symmetric(3, 6)},
			StyleFunc: ui.Colored(colors.Faint)})
	}
	body = append(body, core.View{Style: core.Style{Height: core.Pt(6)}})
	body = append(body, row(T("更改"), fmt.Sprint(len(unstaged)),
		a.pressIcon(lucide.Plus, "暂存全部", 21, 11,
			func() bool { return len(unstaged) == 0 || a.git.busy.Get() != "" }, a.gitStageAll, "")))
	for _, f := range unstaged {
		body = append(body, a.gitFileRow(cx, f, false))
	}
	if len(unstaged) == 0 {
		body = append(body, core.Text{Content: T("工作区干净"), Style: core.Style{FontSize: 10.5, Padding: core.Symmetric(3, 6)},
			StyleFunc: ui.Colored(colors.Faint)})
	}
	return core.View{Style: core.Style{Gap: 1}, Children: body}
}

// gitFileRow is one changed path and its actions.
func (a *app) gitFileRow(cx *core.Scope, f gitFile, staged bool) core.Node {
	colors := ui.ColorsOf(cx)
	tone := gitTone(f, colors)
	name, dir := splitGitPath(f.Path)
	action := func(icon func() *core.SVG, label string, press func(), testID string) core.Node {
		return a.pressIcon(icon, label, 20, 11, func() bool { return a.git.busy.Get() != "" }, press, testID)
	}
	var actions []core.Node
	switch {
	case f.Conflicted:
		// A conflicted path has no "theirs" or "ours" to discard; the
		// dialog offers the three ways out.
		actions = append(actions, action(lucide.GitMerge, "解决冲突 "+name,
			func() { a.gitConflictsOpen.Set(true) }, "git-resolve"))
	case staged:
		actions = append(actions, action(lucide.Minus, "取消暂存 "+name, func() { a.gitUnstageFile(f) }, "git-unstage"))
	default:
		actions = append(actions, action(lucide.Plus, "暂存 "+name, func() { a.gitStageFile(f) }, "git-stage"))
	}
	if !f.Conflicted {
		actions = append(actions, action(lucide.Undo2, "丢弃 "+name, func() { a.gitDiscardFile(f) }, "git-discard"))
	}
	testID := "git-file"
	if staged {
		testID = "git-staged-file"
	}
	return core.View{
		OnPress: func(core.PressEvent) { a.gitShowFileDiff(f, staged) },
		Role:    core.RoleButton, Label: f.Path, TestID: testID,
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinHeight: core.Pt(35),
				Padding: core.Edges{Left: 4, Right: 2}, CornerRadius: 6, Transition: pressMotion,
				Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{
			core.View{Style: core.Style{Width: core.Pt(16), Height: core.Pt(16), CornerRadius: 4, AlignItems: core.AlignCenter,
				JustifyContent: core.JustifyCenter, Background: ui.Alpha(tone, 0.13), FlexShrink: 0},
				Children: []core.Node{ui.Text(f.mark(), 9, ui.Semibold, func() core.Color { return tone })}},
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 0}, Children: []core.Node{
				core.Text{Content: name, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
					Style: core.Style{FontSize: 11.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Text)},
				core.Show{When: func() bool { return dir != "" }, Then: func(cx *core.Scope) core.Node {
					return core.Text{Content: dir, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style: core.Style{FontFamily: ui.Mono, FontSize: 9, LineHeight: 12}, StyleFunc: ui.Colored(colors.Faint)}
				}},
			}},
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 0, FlexShrink: 0}, Children: actions},
		},
	}
}

// gitCommitBox is the message and the commit actions.
func (a *app) gitCommitBox(cx *core.Scope, st gitState) core.Node {
	// The box is its own scope: typing rereads the message here rather
	// than building the file lists and history again.
	return core.Dynamic(func(cx *core.Scope) core.Node { return a.commitBoxBody(cx, st) })
}

// commitBoxBody draws the message, amend switch and commit buttons.
func (a *app) commitBoxBody(cx *core.Scope, st gitState) core.Node {
	colors := ui.ColorsOf(cx)
	msgEmpty := func() bool { return strings.TrimSpace(a.git.msg.Get()) == "" }
	busy := func() bool { return a.git.busy.Get() != "" }
	return core.View{Style: core.Style{Gap: 6, Padding: core.All(9), CornerRadius: 8, Background: colors.Surface(),
		BorderWidth: 1, BorderColor: colors.Border()}, Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
			ui.Icon(lucide.GitCommitHorizontal, 13, colors.Muted),
			ui.Text(T("提交"), 12, ui.Semibold, colors.Text),
			core.View{Style: core.Style{FlexGrow: 1}},
			ui.Text(fmt.Sprintf(T("已暂存 %d"), st.stagedCount()), 9.5, ui.Regular, colors.Faint),
		}},
		core.Input{
			Value: a.git.msg.Get, OnChange: a.git.msg.Set, Multiline: true,
			Placeholder: T("提交说明（第一行是标题）"), Label: T("提交说明"), TestID: "git-commit-message",
			Style: core.Style{MinHeight: core.Pt(58), MaxHeight: core.Pt(120), Padding: core.Symmetric(7, 8), FontSize: 12, Color: colors.Text()},
			StyleFunc: func() core.Style {
				return core.Style{Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 6,
					PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
			},
		},
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
			ui.Checkbox{Checked: a.git.amend.Get, OnChange: a.git.amend.Set, Text: T("修订上次提交"), Label: T("修订上次提交"),
				Style: core.Style{FlexGrow: 1}},
			ui.Button{Text: T("全部提交"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "git-commit-all",
				OnPress:  func() { a.gitCommit(true, false) },
				Disabled: func() bool { return busy() || msgEmpty() || len(st.Files) == 0 }},
			ui.Button{Text: T("提交"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "git-commit",
				OnPress:  func() { a.gitCommit(false, a.git.amend.Get()) },
				Disabled: func() bool { return busy() || msgEmpty() || (st.stagedCount() == 0 && !a.git.amend.Get()) }},
		}},
	}}
}

// gitHistory lists the latest commits.
func (a *app) gitHistory(cx *core.Scope, st gitState) core.Node {
	colors := ui.ColorsOf(cx)
	search := core.Input{Value: a.git.logQuery.Get, OnChange: a.git.logQuery.Set,
		Placeholder: T("搜索提交（标题、作者或哈希）…"), Label: T("搜索提交"), TestID: "git-log-search",
		Style: core.Style{Height: core.Pt(26), Padding: core.Symmetric(0, 8), CornerRadius: 6,
			Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(),
			Color: colors.Text(), FontSize: 10.5}}
	list := core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		query := strings.ToLower(strings.TrimSpace(a.git.logQuery.Get()))
		var rows []core.Node
		shown := 0
		for _, c := range st.Commits {
			commit := c
			if query != "" {
				hay := strings.ToLower(commit.Subject + " " + commit.Author + " " + commit.Short + " " + commit.Hash)
				if !strings.Contains(hay, query) {
					continue
				}
			}
			shown++
			rows = append(rows, base.ContextMenu{
				Trigger: core.View{
					OnPress: func(core.PressEvent) { a.gitShowCommit(commit) },
					Role:    core.RoleButton, Label: commit.Subject, TestID: "git-commit-row",
					StyleFunc: func() core.Style {
						return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinHeight: core.Pt(36),
							Padding: core.Edges{Left: 4, Right: 2}, CornerRadius: 6, Transition: pressMotion,
							Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
					},
					Children: []core.Node{
						ui.Icon(lucide.GitCommitHorizontal, 12, colors.Faint),
						core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 0}, Children: []core.Node{
							core.Text{Content: commit.Subject, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
								Style: core.Style{FontSize: 11.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Text)},
							core.Text{Content: commitLine(commit), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
								Style: core.Style{FontFamily: ui.Mono, FontSize: 9, LineHeight: 12}, StyleFunc: ui.Colored(colors.Faint)},
						}},
						ui.Icon(lucide.ChevronRight, 10, colors.Faint),
					},
				},
				Children: []core.Node{
					a.menuRow(a.cx, lucide.FileDiff, T("查看提交详情"), "", false, func() { a.gitShowCommit(commit) }),
					a.menuRow(a.cx, lucide.Copy, T("复制哈希"), "", false, func() { a.copyText(commit.Hash, "哈希") }),
					a.menuRow(a.cx, lucide.Copy, T("复制提交说明"), "", false, func() { a.copyText(commit.Subject, "提交说明") }),
					a.menuRow(a.cx, lucide.ExternalLink, T("在浏览器打开提交"), "", false, func() { a.openCommitInBrowser(commit) }),
				},
				PopupStyle: core.Style{MinWidth: core.Pt(180)},
				PopupStyleFunc: func() core.Style {
					return a.menuCard(a.cx)
				},
			})
		}
		if len(rows) == 0 {
			msg := T("还没有提交")
			if query != "" {
				msg = T("没有匹配的提交")
			}
			rows = append(rows, core.Text{Content: msg, Style: core.Style{FontSize: 10.5, Padding: core.Symmetric(3, 6)},
				StyleFunc: ui.Colored(colors.Faint)})
		}
		if query == "" && st.LogLimit > 0 && len(st.Commits) >= st.LogLimit && st.LogLimit < 500 {
			rows = append(rows, core.View{OnPress: func(core.PressEvent) { a.git.loadMore() },
				Role: core.RoleButton, Label: T("加载更多提交"), TestID: "git-log-more",
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
						Height: core.Pt(26), CornerRadius: 6, Hover: &core.Style{Background: colors.Hover()}}
				}, Children: []core.Node{ui.Text(T("加载更多提交"), 10.5, ui.Regular, colors.Muted)}})
		}
		return core.View{Style: core.Style{Gap: 3}, Children: append([]core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
				core.Text{Content: T("历史"), Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5, LetterSpacing: 0.5}, StyleFunc: ui.Colored(colors.Faint)},
				core.Text{Content: fmt.Sprint(shown), Style: core.Style{FontFamily: ui.Mono, FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
				core.View{Style: core.Style{FlexGrow: 1}},
				a.pressIcon(lucide.RefreshCw, T("刷新历史"), 21, 11, nil, func() { a.git.refreshAll() }, ""),
			}},
		}, rows...)}
	})
	return core.View{Style: core.Style{Gap: 3}, Children: []core.Node{
		search,
		list,
	}}
}

// commitLine is a commit's short hash, author and day.
func commitLine(c gitCommit) string {
	parts := []string{c.Short}
	if c.Author != "" {
		parts = append(parts, c.Author)
	}
	if !c.Date.IsZero() {
		parts = append(parts, c.Date.Format("2006-01-02"))
	}
	return strings.Join(parts, " · ")
}

// gitTone colors a changed file's mark.
func gitTone(f gitFile, colors ui.Colors) core.Color {
	switch {
	case f.Conflicted:
		return colors.Danger()
	case f.Untracked:
		return colors.Faint()
	case f.mark() == "D":
		return colors.Danger()
	case f.mark() == "A":
		return colors.Up()
	case f.mark() == "R", f.mark() == "C":
		return colors.Info()
	case f.mark() == "M", f.mark() == "T":
		return colors.Warn()
	}
	return colors.Muted()
}

// splitGitPath splits a repository path into its name and its folder.
func splitGitPath(p string) (name, dir string) {
	dir, name = path.Split(strings.ReplaceAll(p, "\\", "/"))
	dir = strings.TrimSuffix(dir, "/")
	return name, dir
}

// --- dialogs ------------------------------------------------------------

// gitDiffDialog shows a file's patch or a commit's.
func (a *app) gitDiffDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		if !a.gitDiffOpen.Get() {
			return nil
		}
		colors := ui.ColorsOf(cx)
		body := core.Dynamic(func(cx *core.Scope) core.Node {
			if a.gitDiffLoading.Get() {
				return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Gap: 8},
					Children: []core.Node{ui.Spinner{Size: 16, Label: "读取补丁"}, ui.Text(T("正在读取补丁…"), 12, ui.Regular, colors.Muted)}}
			}
			patch := a.gitDiffPatch.Get()
			if strings.TrimSpace(patch) == "" {
				return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter},
					Children: []core.Node{ui.Text(T("没有可显示的差异"), 12, ui.Regular, colors.Faint)}}
			}
			if strings.HasPrefix(patch, "无法读取") {
				return core.View{Style: core.Style{FlexGrow: 1, Padding: core.All(16)},
					Children: []core.Node{core.Text{Content: patch, Style: core.Style{FontSize: 12, LineHeight: 18}, StyleFunc: ui.Colored(colors.Danger)}}}
			}
			return uidiff.View{Patch: func() string { return patch }, Unified: true, Selectable: true, SoftWrap: true,
				Style: core.Style{FlexGrow: 1, MinHeight: core.Pt(0)}}
		})
		return ui.Dialog{
			Open: a.gitDiffOpen.Get, OnOpenChange: func(open bool, _ base.Reason) { a.gitDiffOpen.Set(open) },
			Title: a.gitDiffTitle.Get(), Description: a.gitDiffSub.Get(), TestID: "git-diff",
			Style: core.Style{Width: core.Pt(900), Height: core.Pt(640)},
			Children: []core.Node{core.View{Style: core.Style{FlexGrow: 1, MinHeight: core.Pt(0),
				BorderWidth: 1, BorderColor: colors.Border(), CornerRadius: 8, Overflow: core.Hidden}, Children: []core.Node{body}}},
			Footer: []core.Node{
				core.Show{When: func() bool { return a.gitDiffHash != "" }, Then: func(*core.Scope) core.Node {
					return ui.Button{Text: T("复制哈希"), Variant: ui.ButtonGhost, TestID: "git-diff-hash",
						OnPress: func() { a.copyText(a.gitDiffHash, "哈希") }}
				}},
				ui.Button{Text: T("复制补丁"), Variant: ui.ButtonGhost, OnPress: func() {
					a.copyText(a.gitDiffPatch.GetUntracked(), "补丁")
				}},
				core.View{Style: core.Style{FlexGrow: 1}},
				ui.Button{Text: T("关闭"), Variant: ui.ButtonPrimary, OnPress: func() { a.gitDiffOpen.Set(false) }},
			},
		}
	})
}

// gitNewBranchDialog names a branch and makes it.
func (a *app) gitNewBranchDialog() core.Node {
	colors := ui.ColorsOf(a.cx)
	return ui.Dialog{
		Open: a.gitNewBranchOpen.Get, OnOpenChange: func(open bool, _ base.Reason) { a.gitNewBranchOpen.Set(open) },
		Title: T(T("新建分支")), Description: T("新分支从当前提交开始，并立刻切换过去。"), TestID: "git-new-branch",
		Children: []core.Node{core.Input{
			Value: a.gitNewBranchName.Get, OnChange: a.gitNewBranchName.Set, Placeholder: "feature/my-change",
			Label: T("分支名"), AutoFocus: true, OnSubmit: func(string) { a.gitCreateBranch() },
			StyleFunc: func() core.Style {
				return core.Style{Height: core.Pt(34), Padding: core.Symmetric(0, 10), CornerRadius: 7, Background: colors.Field(),
					BorderWidth: 1, BorderColor: colors.FieldBorder(), Color: colors.Text(), FontSize: 13}
			},
		}},
		Footer: []core.Node{
			ui.Button{Text: "取消", Variant: ui.ButtonGhost, OnPress: func() { a.gitNewBranchOpen.Set(false) }},
			ui.Button{Text: T("创建并切换"), Variant: ui.ButtonPrimary, OnPress: a.gitCreateBranch},
		},
	}
}
