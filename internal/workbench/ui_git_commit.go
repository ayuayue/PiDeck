//go:build !js && !android && !ios

package workbench

// The Git drawer's commit box: the message, a way to draft it, and the
// commit actions. It is built once and updates through functions: a status
// read must never rebuild the field under the caret.

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// gitCommitBox is the message and the commit actions. It reads as one
// field, not a card: the drawer's sections are flat, and a card inside the
// field it holds is a box in a box.
func (a *app) gitCommitBox(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	msgEmpty := func() bool { return strings.TrimSpace(a.git.msg.Get()) == "" }
	busy := func() bool { return a.git.busy.Get() != "" }
	staged := func() int { return a.git.state.Get().stagedCount() }
	changed := func() int { return len(a.git.state.Get().Files) }
	amend := a.git.amend.Get
	conflicted := func() bool { return len(a.git.state.Get().conflicts()) > 0 }
	return core.View{Style: core.Style{Gap: viewkit.PanelGap, FlexShrink: 0, Padding: core.Edges{Top: viewkit.PanelGap}, Borders: core.Edges{Top: 1}, BorderColors: core.EdgeColors{Top: colors.Line()}}, Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(viewkit.PanelControlSize)}, Children: []core.Node{
			gitSectionTitle(colors, apptext.T("提交")),
			// Nothing staged means nothing to commit: the count would
			// only say zero.
			core.Show{When: func() bool { return staged() > 0 }, Then: func(*core.Scope) core.Node {
				return core.Text{ContentFunc: func() string { return fmt.Sprintf(apptext.T("已暂存 %d"), staged()) }, MaxLines: 1,
					Style: core.Style{FontSize: viewkit.PanelCaptionSize}, StyleFunc: ui.Colored(colors.Muted)}
			}},
			core.View{Style: core.Style{FlexGrow: 1}},
			hint("生成提交摘要", a.pressIcon(lucide.Sparkles, apptext.T("生成提交摘要"), viewkit.PanelControlSize, viewkit.PanelIconSize,
				func() bool { return busy() || a.aiBusy.Get() != "" }, a.generateCommitMessage, "git-summary")),
		}},
		core.Input{
			Value: a.git.msg.Get, OnChange: a.git.msg.Set, Multiline: true,
			Placeholder: apptext.T("提交说明（第一行是标题）"), Label: apptext.T("提交说明"), TestID: "git-commit-message",
			Style: core.Style{MinHeight: core.Pt(80), MaxHeight: core.Pt(128), Padding: core.All(12), FontSize: viewkit.PanelTextSize, LineHeight: viewkit.PanelLineHeight},
			StyleFunc: func() core.Style {
				return core.Style{Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), CornerRadius: 8,
					Color: colors.Text(), PlaceholderColor: colors.Muted(), CaretColor: colors.Text(), SelectionColor: colors.Now().Selection,
					FocusVisible: ui.FocusRing(cx, 2)}
			},
		},
		core.Dynamic(func(*core.Scope) core.Node { return a.recentMessageMenu(a.cx) }),
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
			ui.Checkbox{Checked: amend, OnChange: a.git.amend.Set, Text: apptext.T("修订上次提交"), Label: apptext.T("修订上次提交"),
				Hint: apptext.T("把这次改动并入上一次提交，不新增提交"), Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)}},
			ui.Button{Text: apptext.T("全部提交"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "git-commit-all",
				OnPress:  func() { a.gitCommit(true, false) },
				Disabled: func() bool { return busy() || conflicted() || msgEmpty() || changed() == 0 }},
			hint("提交并推送", a.pressIcon(lucide.CloudUpload, apptext.T("提交并推送"), viewkit.PanelControlSize, viewkit.PanelIconSize,
				func() bool { return busy() || conflicted() || msgEmpty() || staged() == 0 }, a.gitCommitAndPush, "git-commit-push")),
		}},
		core.Show{When: conflicted, Then: func(*core.Scope) core.Node {
			return core.Text{Content: apptext.T("请先解决冲突再提交"), Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: viewkit.PanelLineHeight}, StyleFunc: ui.Colored(colors.Danger)}
		}},
		ui.Button{Text: apptext.T("提交"), Variant: ui.ButtonPrimary, Size: ui.SizeDefault, Style: core.Style{Height: core.Pt(viewkit.PanelFieldHeight)}, TestID: "git-commit",
			OnPress:  func() { a.gitCommit(false, a.git.amend.Get()) },
			Disabled: func() bool { return busy() || conflicted() || msgEmpty() || (staged() == 0 && !amend()) }},
		core.Show{When: amend, Then: func(*core.Scope) core.Node {
			return core.Text{Content: apptext.T("这次的暂存改动会并入上一次提交，不再新增提交。"),
				Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: viewkit.PanelLineHeight}, StyleFunc: ui.Colored(colors.Faint)}
		}},
	}}
}

// recentMessageMenu is the newest commit's message, with the ones before it
// a press away: one quiet line instead of a row of chips, which shrink the
// box and say the same thing three times.
func (a *app) recentMessageMenu(cx *core.Scope) core.Node {
	colors := ui.ColorsOf(cx)
	subjects := gitRecentSubjects(a.git.state.Get().Commits, gitRecentMessages)
	if len(subjects) == 0 {
		return nil
	}
	items := make([]core.Node, 0, len(subjects))
	for _, subject := range subjects {
		subject := subject
		items = append(items, base.MenuItem{
			Label: subject, TestID: "git-msg-recent-item", OnSelect: func() { a.git.msg.Set(subject) },
			Children: []core.Node{core.Text{Content: subject, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style:     core.Style{FontSize: viewkit.PanelTextSize, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)},
				StyleFunc: ui.Colored(colors.Text)}},
			Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(viewkit.PanelRowHeight),
				Padding: core.Symmetric(0, 8), CornerRadius: 6},
			StyleFunc: func() core.Style {
				return core.Style{Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()},
					Focus: &core.Style{Background: colors.Hover()}, Transition: viewkit.PressMotion}
			},
		})
	}
	return base.Menu{
		Open: a.git.recentOpen.Get, OnOpenChange: func(open bool, _ base.Reason) { a.git.recentOpen.Set(open) },
		Label: apptext.T("用最近的提交说明"), TestID: "git-msg-recent",
		Placement: core.PlaceBottom, Align: core.AlignStart, Offset: 4, Margin: 8,
		Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Height: core.Pt(viewkit.PanelControlSize),
			MaxWidth: core.Pct(100), Padding: core.Symmetric(0, 5), CornerRadius: 6, FlexShrink: 1},
		StyleFunc: func() core.Style {
			return core.Style{Transition: viewkit.PressMotion, Hover: &core.Style{Background: colors.Hover()},
				Active: &core.Style{Background: colors.Pressed()}, FocusVisible: ui.FocusRing(a.cx, 2)}
		},
		Trigger: core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, MinWidth: core.Pt(0)},
			Children: []core.Node{
				ui.Icon(lucide.Clock, viewkit.PanelDetailIconSize, colors.Muted),
				core.Text{Content: subjects[0], MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style:     core.Style{FontSize: viewkit.PanelCaptionSize, FlexShrink: 1, MinWidth: core.Pt(0)},
					StyleFunc: ui.Colored(colors.Muted)},
				ui.Icon(lucide.ChevronDown, 12, colors.Faint),
			}},
		PopupStyle: a.menuPopup(cx), PopupStyleFunc: func() core.Style {
			style := a.menuCard(a.cx)
			style.MaxWidth = core.Pt(304)
			return style
		},
		Children: items,
	}
}

// gitRecentMessages is how many earlier subjects the menu offers.
const gitRecentMessages = 8

// gitRecentSubjects is the newest commit subjects, de-duplicated and cut to
// limit: a repeated subject is one choice, not two rows saying the same
// thing.
func gitRecentSubjects(commits []gitCommit, limit int) []string {
	out := make([]string, 0, limit)
	seen := map[string]bool{}
	for _, c := range commits {
		subject := strings.TrimSpace(c.Subject)
		if subject == "" || seen[subject] {
			continue
		}
		seen[subject] = true
		out = append(out, subject)
		if len(out) >= limit {
			break
		}
	}
	return out
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
