//go:build !js && !android && !ios

package workbench

// Git remotes: the named URLs, adding one, and removing one.

import (
	"fmt"
	"strings"
	"time"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// openGitRemotes shows the remote list.
func (a *app) openGitRemotes() {
	a.gitRemoteName.Set("origin")
	a.gitRemoteURL.Set("")
	a.gitRemotesOpen.Set(true)
}

// addGitRemote adds the name and URL the dialog shows.
func (a *app) addGitRemote() {
	name := strings.TrimSpace(a.gitRemoteName.GetUntracked())
	url := strings.TrimSpace(a.gitRemoteURL.GetUntracked())
	switch {
	case name == "" || url == "":
		a.toast(ui.ToastWarning, "还差名称或地址", "名称常用 origin，地址是仓库的 https 或 ssh 链接。")
		return
	case strings.ContainsAny(name, " \t"):
		a.toast(ui.ToastWarning, "远端名不能有空格", "")
		return
	}
	a.git.run("添加远端", func(g gitRunner) error {
		_, err := g.exec(60*time.Second, "remote", "add", name, url)
		return err
	}, func(err error) {
		if err == nil {
			a.gitRemoteURL.Set("")
		}
	})
}

// removeGitRemote deletes a remote after asking.
func (a *app) removeGitRemote(name string) {
	if strings.TrimSpace(name) == "" {
		return
	}
	a.askConfirm("删除远端", "远端「"+name+"」会从本地配置里移除；仓库本身不受影响。", "删除", func() {
		a.git.run("删除远端", func(g gitRunner) error {
			_, err := g.exec(60*time.Second, "remote", "remove", name)
			return err
		}, nil)
	})
}

// gitRemotesDialog lists remotes and adds one.
func (a *app) gitRemotesDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		st := a.git.state.Get()
		var rows []core.Node
		for i, remote := range st.Remotes {
			idx := i
			item := remote
			rows = append(rows, core.View{TestID: fmt.Sprintf("git-remote-row-%d", i),
				Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(38),
					Padding: core.Symmetric(3, 6)}, Children: []core.Node{
					ui.Icon(lucide.Cloud, 12, colors.Muted),
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
						core.Text{Content: item.Name, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11.5}, StyleFunc: ui.Colored(colors.Text)},
						core.Text{Content: item.URL, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style: core.Style{FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
					}},
					core.View{OnPress: func(core.PressEvent) { a.copyText(item.URL, "远端地址") }, Role: core.RoleButton,
						Label: apptext.T("复制远端地址"), StyleFunc: func() core.Style {
							return core.Style{Width: core.Pt(22), Height: core.Pt(22), CornerRadius: 5, AlignItems: core.AlignCenter,
								JustifyContent: core.JustifyCenter, Hover: &core.Style{Background: colors.Hover()}}
						}, Children: []core.Node{ui.Icon(lucide.Copy, 11, colors.Faint)}},
					core.View{OnPress: func(core.PressEvent) { a.removeGitRemote(item.Name) }, Role: core.RoleButton,
						Label: apptext.T("删除远端") + " " + item.Name, TestID: fmt.Sprintf("git-remote-delete-%d", idx),
						StyleFunc: func() core.Style {
							return core.Style{Width: core.Pt(22), Height: core.Pt(22), CornerRadius: 5, AlignItems: core.AlignCenter,
								JustifyContent: core.JustifyCenter, Hover: &core.Style{Background: colors.Pressed()}}
						}, Children: []core.Node{ui.Icon(lucide.Trash, 11, colors.Faint)}},
				}})
		}
		if len(rows) == 0 {
			rows = append(rows, core.Text{Content: apptext.T("还没有远端。"), Style: core.Style{FontSize: 11, Padding: core.All(8)},
				StyleFunc: ui.Colored(colors.Faint)})
		}
		return ui.Dialog{
			Open:         a.gitRemotesOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.gitRemotesOpen.Set(open) },
			Title:        apptext.T("远端"),
			TestID:       "git-remotes",
			Style:        core.Style{Width: a.dialogWidth(), MaxHeight: core.Pt(560)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 8}, Children: []core.Node{
				core.Scroll{Style: core.Style{MaxHeight: core.Pt(280)}, Children: []core.Node{
					core.View{Style: core.Style{Gap: 1}, Children: rows}}},
				core.View{Style: core.Style{Direction: core.Row, Gap: 6}, Children: []core.Node{
					core.View{Style: core.Style{Width: core.Pt(110)}, Children: []core.Node{
						core.Input{Value: a.gitRemoteName.Get, OnChange: a.gitRemoteName.Set, Placeholder: "origin", Label: apptext.T("远端名"),
							TestID: "git-remote-name",
							Style: core.Style{Height: core.Pt(30), Padding: core.Symmetric(0, 8), CornerRadius: 6, FontSize: 11.5,
								FontFamily: viewkit.MonoFont(), Color: colors.Text(), Background: colors.Field(),
								BorderWidth: 1, BorderColor: colors.FieldBorder()}},
					}},
					core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0)}, Children: []core.Node{
						core.Input{Value: a.gitRemoteURL.Get, OnChange: a.gitRemoteURL.Set, Placeholder: "https://github.com/…/repo.git",
							Label: apptext.T("远端地址"), TestID: "git-remote-url", OnSubmit: func(string) { a.addGitRemote() },
							Style: core.Style{Height: core.Pt(30), Padding: core.Symmetric(0, 8), CornerRadius: 6, FontSize: 11,
								FontFamily: viewkit.MonoFont(), Color: colors.Text(), Background: colors.Field(),
								BorderWidth: 1, BorderColor: colors.FieldBorder()}},
					}},
					ui.Button{Text: apptext.T("添加远端"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "git-remote-add",
						Disabled: func() bool { return a.git.busy.Get() != "" }, OnPress: a.addGitRemote},
				}},
			}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "git-remote-close",
					OnPress: func() { a.gitRemotesOpen.Set(false) }},
			},
		}
	})
}
