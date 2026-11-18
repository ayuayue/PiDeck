//go:build !js && !android && !ios

package workbench

// The Git drawer: the branch and its upstream, changed files with their
// stage, unstage and discard actions, the commit box, the history and the
// patch dialog. The repository is read by git.go; this file only draws it
// and sends the user's actions back.

import (
	"path/filepath"
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
	uidiff "github.com/nsgo-dev/nsgo/ui/diff"
)

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
					Children: []core.Node{ui.Spinner{Size: 16, Label: apptext.T("读取补丁")}, ui.Text(apptext.T("正在读取补丁…"), 12, ui.Regular, colors.Muted)}}
			}
			patch := a.gitDiffPatch.Get()
			if strings.TrimSpace(patch) == "" {
				return core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter},
					Children: []core.Node{ui.Text(apptext.T("没有可显示的差异"), 12, ui.Regular, colors.Faint)}}
			}
			if strings.HasPrefix(patch, "无法读取") {
				return core.View{Style: core.Style{FlexGrow: 1, Padding: core.All(16)},
					Children: []core.Node{core.Text{Content: patch, Style: core.Style{FontSize: 12, LineHeight: 18}, StyleFunc: ui.Colored(colors.Danger)}}}
			}
			var head []core.Node
			if a.gitDiffHash != "" {
				if files := diffFiles(patch); len(files) > 0 {
					var chips []core.Node
					for _, f := range files {
						f := f
						chips = append(chips, core.View{
							OnPress: func(core.PressEvent) {
								root := a.gitPath()
								if root == "" {
									return
								}
								a.gitDiffOpen.Set(false)
								a.openEditorFile(root, filepath.Join(root, filepath.FromSlash(f)))
							},
							Role: core.RoleButton, Label: f, TestID: "git-diff-file",
							StyleFunc: func() core.Style {
								return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, Height: core.Pt(22),
									Padding: core.Symmetric(0, 7), CornerRadius: 5, Background: colors.Inset(),
									Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
							},
							Children: []core.Node{
								ui.Icon(lucide.FileText, 10, colors.Faint),
								core.Text{Content: f, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
									Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10}, StyleFunc: ui.Colored(colors.Muted)},
							}})
					}
					head = append(head, core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 5}, Children: chips})
				}
			}
			return core.View{Style: core.Style{FlexGrow: 1, MinHeight: core.Pt(0), Gap: 6}, Children: append(head,
				uidiff.View{Patch: func() string { return patch }, Unified: true, Selectable: true, SoftWrap: true,
					Style: core.Style{FlexGrow: 1, MinHeight: core.Pt(0)}})}
		})
		return ui.Dialog{
			Open: a.gitDiffOpen.Get, OnOpenChange: func(open bool, _ base.Reason) { a.gitDiffOpen.Set(open) },
			Title: a.gitDiffTitle.Get(), Description: a.gitDiffSub.Get(), TestID: "git-diff",
			Style: core.Style{Width: core.Pt(900), Height: core.Pt(640)},
			Children: []core.Node{core.View{Style: core.Style{FlexGrow: 1, MinHeight: core.Pt(0),
				BorderWidth: 1, BorderColor: colors.Border(), CornerRadius: 8, Overflow: core.Hidden}, Children: []core.Node{body}}},
			Footer: []core.Node{
				core.Show{When: func() bool { return a.gitDiffHash != "" }, Then: func(*core.Scope) core.Node {
					return ui.Button{Text: apptext.T("复制哈希"), Variant: ui.ButtonGhost, TestID: "git-diff-hash",
						OnPress: func() { a.copyText(a.gitDiffHash, "哈希") }}
				}},
				core.Show{When: func() bool { return a.gitDiffHash == "" }, Then: func(*core.Scope) core.Node {
					return ui.Button{Text: apptext.T("历史"), Variant: ui.ButtonGhost, TestID: "git-file-history",
						OnPress: func() { a.openFileHistory(a.gitDiffTitle.GetUntracked()) }}
				}},
				core.Show{When: func() bool { return a.gitDiffHash == "" }, Then: func(*core.Scope) core.Node {
					return ui.Button{Text: apptext.T("追溯"), Variant: ui.ButtonGhost, TestID: "git-file-blame",
						OnPress: func() { a.openBlame(a.gitDiffTitle.GetUntracked()) }}
				}},
				ui.Button{Text: apptext.T("复制补丁"), Variant: ui.ButtonGhost, OnPress: func() {
					a.copyText(a.gitDiffPatch.GetUntracked(), "补丁")
				}},
				core.View{Style: core.Style{FlexGrow: 1}},
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonPrimary, OnPress: func() { a.gitDiffOpen.Set(false) }},
			},
		}
	})
}

// gitNewBranchDialog names a branch and makes it.
func (a *app) gitNewBranchDialog() core.Node {
	colors := ui.ColorsOf(a.cx)
	return ui.Dialog{
		Open: a.gitNewBranchOpen.Get, OnOpenChange: func(open bool, _ base.Reason) { a.gitNewBranchOpen.Set(open) },
		Title: apptext.T("新建分支"), Description: apptext.T("新分支从当前提交开始，并立刻切换过去。"), TestID: "git-new-branch",
		Children: []core.Node{core.Input{
			Value: a.gitNewBranchName.Get, OnChange: a.gitNewBranchName.Set, Placeholder: "feature/my-change",
			Label: apptext.T("分支名"), AutoFocus: true, OnSubmit: func(string) { a.gitCreateBranch() },
			StyleFunc: func() core.Style {
				return core.Style{Height: core.Pt(34), Padding: core.Symmetric(0, 10), CornerRadius: 7, Background: colors.Field(),
					BorderWidth: 1, BorderColor: colors.FieldBorder(), Color: colors.Text(), FontSize: 13}
			},
		}},
		Footer: []core.Node{
			ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, OnPress: func() { a.gitNewBranchOpen.Set(false) }},
			ui.Button{Text: apptext.T("创建并切换"), Variant: ui.ButtonPrimary, OnPress: a.gitCreateBranch},
		},
	}
}
