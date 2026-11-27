//go:build !js && !android && !ios

package workbench

// Git tags: the list, a tag at HEAD, and deleting one.

import (
	"fmt"
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// openGitTags shows the tag list.
func (a *app) openGitTags() {
	a.gitTagText.Set("")
	a.gitTagsOpen.Set(true)
}

// createGitTag tags the current commit with the name typed.
func (a *app) createGitTag() {
	name := strings.TrimSpace(a.gitTagText.GetUntracked())
	if name == "" {
		a.toast(ui.ToastWarning, "还差标签名", "例如 v1.0.0。")
		return
	}
	if strings.ContainsAny(name, " ~^:?*[\\") || strings.HasPrefix(name, "-") {
		a.toast(ui.ToastWarning, "标签名不合法", "不要有空格或特殊字符。")
		return
	}
	a.git.run("创建标签", func(g gitRunner) error {
		_, err := g.exec(60*time.Second, "tag", name)
		return err
	}, func(err error) {
		if err == nil {
			a.gitTagText.Set("")
		}
	})
}

// deleteGitTag removes a tag after asking.
func (a *app) deleteGitTag(name string) {
	if strings.TrimSpace(name) == "" {
		return
	}
	a.askConfirm("删除标签", "标签「"+name+"」会从本地删除；远端标签不受影响。", "删除", func() {
		a.git.run("删除标签", func(g gitRunner) error {
			_, err := g.exec(60*time.Second, "tag", "-d", name)
			return err
		}, nil)
	})
}

// gitTagsDialog lists tags and creates one.
func (a *app) gitTagsDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		st := a.git.state.Get()
		var rows []core.Node
		for i, tag := range st.Tags {
			idx := i
			name := tag
			rows = append(rows, core.View{TestID: fmt.Sprintf("git-tag-row-%d", i),
				Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(34),
					Padding: core.Symmetric(3, 6)}, Children: []core.Node{
					ui.Icon(lucide.Tag, 12, colors.Muted),
					core.Text{Content: name, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
						Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: viewkit.MonoFont(), FontSize: 11.5},
						StyleFunc: ui.Colored(colors.Text)},
					core.View{OnPress: func(core.PressEvent) { a.copyText(name, "标签") }, Role: core.RoleButton, Label: apptext.T("复制标签") + " " + name,
						StyleFunc: func() core.Style {
							return core.Style{Width: core.Pt(22), Height: core.Pt(22), CornerRadius: 5, AlignItems: core.AlignCenter,
								JustifyContent: core.JustifyCenter, Hover: &core.Style{Background: colors.Hover()}}
						}, Children: []core.Node{ui.Icon(lucide.Copy, 11, colors.Faint)}},
					core.View{OnPress: func(core.PressEvent) { a.deleteGitTag(name) }, Role: core.RoleButton, Label: apptext.T("删除标签") + " " + name,
						TestID: fmt.Sprintf("git-tag-delete-%d", idx),
						StyleFunc: func() core.Style {
							return core.Style{Width: core.Pt(22), Height: core.Pt(22), CornerRadius: 5, AlignItems: core.AlignCenter,
								JustifyContent: core.JustifyCenter, Hover: &core.Style{Background: colors.Pressed()}}
						}, Children: []core.Node{ui.Icon(lucide.Trash, 11, colors.Faint)}},
				}})
		}
		if len(rows) == 0 {
			rows = append(rows, core.Text{Content: apptext.T("还没有标签。"), Style: core.Style{FontSize: 11, Padding: core.All(8)},
				StyleFunc: ui.Colored(colors.Faint)})
		}
		return ui.Dialog{
			Open:         a.gitTagsOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.gitTagsOpen.Set(open) },
			Title:        apptext.T("标签"),
			TestID:       "git-tags",
			Style:        core.Style{Width: a.dialogWidth(), MaxHeight: core.Pt(560)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 8}, Children: []core.Node{
				a.scrollStashFor("gitTagsDialog:1").Bind(cx, core.Scroll{Style: core.Style{MaxHeight: core.Pt(300)}, Children: []core.Node{
					core.View{Style: core.Style{Gap: 1, Padding: core.Edges{Right: viewkit.PanelInset}}, Children: rows}}}),
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
						core.Input{Value: a.gitTagText.Get, OnChange: a.gitTagText.Set, Placeholder: "v1.0.0", Label: apptext.T("标签名"),
							TestID: "git-tag-name", OnSubmit: func(string) { a.createGitTag() },
							Style: core.Style{Height: core.Pt(30), Padding: core.Symmetric(0, 8), CornerRadius: 6, FontSize: 11.5,
								FontFamily: viewkit.MonoFont(), Color: colors.Text(), Background: colors.Field(),
								BorderWidth: 1, BorderColor: colors.FieldBorder()}},
					}},
					ui.Button{Text: apptext.T("在当前提交打标签"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "git-tag-create",
						Disabled: func() bool { return a.git.busy.Get() != "" }, OnPress: a.createGitTag},
				}},
			}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "git-tag-close",
					OnPress: func() { a.gitTagsOpen.Set(false) }},
			},
		}
	})
}
