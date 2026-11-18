//go:build !js && !android && !ios

package workbench

// The Git drawer: the branch and its upstream, changed files with their
// stage, unstage and discard actions, the commit box, the history and the
// patch dialog. The repository is read by git.go; this file only draws it
// and sends the user's actions back.

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

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
			ui.Text(apptext.T("提交"), 12, ui.Semibold, colors.Text),
			core.View{Style: core.Style{FlexGrow: 1}},
			ui.Text(fmt.Sprintf(apptext.T("已暂存 %d"), st.stagedCount()), 9.5, ui.Regular, colors.Faint),
			a.pressIcon(lucide.Sparkles, apptext.T("生成提交摘要"), 21, 11,
				func() bool { return busy() || a.aiBusy.Get() != "" }, a.generateCommitMessage, "git-summary"),
		}},
		core.Input{
			Value: a.git.msg.Get, OnChange: a.git.msg.Set, Multiline: true,
			Placeholder: apptext.T("提交说明（第一行是标题）"), Label: apptext.T("提交说明"), TestID: "git-commit-message",
			Style: core.Style{MinHeight: core.Pt(58), MaxHeight: core.Pt(120), Padding: core.Symmetric(7, 8), FontSize: 12, Color: colors.Text()},
			StyleFunc: func() core.Style {
				return core.Style{Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 6,
					PlaceholderColor: colors.Faint(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection}
			},
		},
		recentMessages(a, st),
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
			ui.Checkbox{Checked: a.git.amend.Get, OnChange: a.git.amend.Set, Text: apptext.T("修订上次提交"), Label: apptext.T("修订上次提交"),
				Hint: apptext.T("把这次改动并入上一次提交，不新增提交"), Style: core.Style{FlexGrow: 1}},
			ui.Button{Text: apptext.T("全部提交"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "git-commit-all",
				OnPress:  func() { a.gitCommit(true, false) },
				Disabled: func() bool { return busy() || msgEmpty() || len(st.Files) == 0 }},
			a.pressIcon(lucide.CloudUpload, apptext.T("提交并推送"), 24, 12,
				func() bool { return busy() || msgEmpty() || st.stagedCount() == 0 }, a.gitCommitAndPush, "git-commit-push"),
			ui.Button{Text: apptext.T("提交"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "git-commit",
				OnPress:  func() { a.gitCommit(false, a.git.amend.Get()) },
				Disabled: func() bool { return busy() || msgEmpty() || (st.stagedCount() == 0 && !a.git.amend.Get()) }},
		}},
		core.Show{When: func() bool { return a.git.amend.Get() }, Then: func(*core.Scope) core.Node {
			return core.Text{Content: apptext.T("这次的暂存改动会并入上一次提交，不再新增提交。"),
				Style: core.Style{FontSize: 9.5, LineHeight: 14}, StyleFunc: ui.Colored(colors.Faint)}
		}},
	}}
}

// generateCommitMessage asks the commit tool's model for a message from
// the staged diff and puts it in the box.
func (a *app) generateCommitMessage() {
	if a.aiBusy.GetUntracked() != "" || a.gitPath() == "" {
		return
	}
	if !a.toolConfigured("commit") {
		a.toast(ui.ToastInfo, apptext.T("还没有配置提交摘要的模型"), apptext.T("到 设置 → 模型 → 工具模型 里选供应商和模型。"))
		return
	}
	runner := a.git.runner()
	a.aiBusy.Set("commit")
	go func() {
		diff, err := runner.exec(60*time.Second, "diff", "--cached", "--no-color")
		if err == nil && strings.TrimSpace(diff) == "" {
			diff, err = runner.exec(60*time.Second, "diff", "--no-color")
		}
		var recent string
		if err == nil {
			recent, _ = runner.exec(30*time.Second, "--no-pager", "log", "-n", "5", "--pretty=format:%s")
		}
		if err == nil && strings.TrimSpace(diff) == "" {
			err = errors.New("没有可总结的改动")
		}
		msg := ""
		if err == nil {
			if len(diff) > 24000 {
				diff = diff[:24000] + "\n…（已截断）"
			}
			prompt := "最近的提交标题：\n" + recent + "\n\n暂存或未暂存的改动：\n" + diff
			msg, err = a.complete("commit",
				"你是提交说明助手。根据 diff 写一条提交说明，风格与最近的提交标题一致；第一行是简洁的祈使句标题，不超过 72 字符，需要时再加空行和要点。若最近的标题是英文就用英文，是中文就用中文。只输出提交说明，不要代码块或解释。",
				prompt, 400)
		}
		a.cx.Post(func() {
			a.aiBusy.Set("")
			if err != nil {
				a.toast(ui.ToastError, apptext.T("生成提交摘要失败"), viewkit.FirstLine(err.Error(), 160))
				return
			}
			text := cleanLLMText(msg)
			a.git.msg.Set(text)
			a.toast(ui.ToastSuccess, apptext.T("提交摘要已生成"), viewkit.FirstLine(text, 90))
		})
	}()
}

// recentMessages offers the last commit subjects while the box is empty.
func recentMessages(a *app, st gitState) core.Node {
	colors := ui.ColorsOf(a.cx)
	var chips []core.Node
	seen := map[string]bool{}
	for _, c := range st.Commits {
		subject := strings.TrimSpace(c.Subject)
		if subject == "" || seen[subject] {
			continue
		}
		seen[subject] = true
		text := subject
		chips = append(chips, core.View{
			OnPress: func(core.PressEvent) { a.git.msg.Set(text) },
			Role:    core.RoleButton, Label: apptext.T("用上次的说明：") + subject, TestID: "git-msg-recent",
			StyleFunc: func() core.Style {
				return core.Style{MaxWidth: core.Pt(150), Height: core.Pt(20), Padding: core.Symmetric(0, 7), CornerRadius: 10,
					BorderWidth: 1, BorderColor: colors.Border(), Hover: &core.Style{Background: colors.Hover()}}
			},
			Children: []core.Node{core.Text{Content: subject, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FontSize: 9.5}, StyleFunc: ui.Colored(colors.Muted)}},
		})
		if len(chips) >= 3 {
			break
		}
	}
	if len(chips) == 0 {
		return core.View{}
	}
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, Wrap: core.Wrap}, Children: chips}
}
