//go:build !js && !android && !ios

package workbench

// The window: a rail of projects and sessions, a bar of session tabs, the
// chat, and a drawer for the session's numbers and the project's files.

import (
	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// openTargetDialog opens the remote workspace dialog for a kind.
func (a *app) openTargetDialog(kind targetKind) {
	a.addKind.Set(int(kind))
	info := a.env.GetUntracked()
	where := ""
	if kind == targetWSL && len(info.WSL) > 0 {
		where = info.WSL[0].Name
	}
	if kind == targetSSH && len(info.SSH) > 0 {
		where = info.SSH[0].Name
	}
	a.addWhere.Set(where)
	a.addPath.Set("")
	a.addTarget.Set(true)
}

// targetDialog names a folder on WSL or on an SSH host to work in.
func (a *app) targetDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		kind := targetKind(a.addKind.Get())
		env := a.env.Get()
		var options []string
		var label, hint, placeholder string
		if kind == targetSSH {
			for _, h := range env.SSH {
				options = append(options, h.Name)
			}
			label, hint = apptext.T("SSH 主机"), apptext.T("从 ~/.ssh/config 里读到的 Host；远端需要装好 pi，并已配置免密登录。")
			placeholder = "/home/you/project"
		} else {
			for _, d := range env.WSL {
				options = append(options, d.Name)
			}
			label, hint = apptext.T("WSL 发行版"), apptext.T("在 Windows 上通过 wsl.exe 运行 pi；会话存在该发行版的 ~/.pideck-v2/sessions。")
			placeholder = "$HOME/project 或 /mnt/c/Users/you/project"
		}
		if len(options) == 0 {
			options = []string{""}
		}
		var chips []core.Node
		for _, o := range options {
			value := o
			selected := func() bool { return a.addWhere.Get() == value }
			chips = append(chips, core.View{
				OnPress: func(core.PressEvent) { a.addWhere.Set(value) },
				Role:    core.RoleRadio, Label: value,
				StyleFunc: func() core.Style {
					st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Height: core.Pt(26), Padding: core.Symmetric(0, 10),
						CornerRadius: 13, BorderWidth: 1, BorderColor: colors.Border(), Hover: &core.Style{Background: colors.Hover()}}
					if selected() {
						st.Background = colors.Pressed()
						st.BorderColor = colors.Text()
					}
					return st
				},
				Children: []core.Node{ui.Text(value, 12, ui.Regular, colors.Text)},
			})
		}
		return ui.Dialog{
			Open:         a.addTarget.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.addTarget.Set(open) },
			Title:        apptext.T(map[targetKind]string{targetWSL: "在 WSL 里工作", targetSSH: "在 SSH 主机上工作"}[kind]),
			Description:  hint,
			TestID:       "target-dialog",
			Children: []core.Node{
				core.View{Style: core.Style{Gap: 6}, Children: []core.Node{
					ui.Text(label, 12.5, ui.Semibold, colors.Text),
					core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 6}, Children: chips},
					core.Show{When: func() bool { return len(options) == 1 && options[0] == "" }, Then: func(*core.Scope) core.Node {
						return core.Text{Content: apptext.T("没有读到可用的目标：先在系统里配一个 WSL 发行版或 SSH Host。"),
							Style: core.Style{FontSize: 11.5, LineHeight: 17}, StyleFunc: ui.Colored(colors.Warn)}
					}},
				}},
				core.View{Style: core.Style{Gap: 6}, Children: []core.Node{
					ui.Text(apptext.T("目录"), 12.5, ui.Semibold, colors.Text),
					core.Input{
						Value: a.addPath.Get, OnChange: a.addPath.Set, Placeholder: placeholder, Label: apptext.T("远端目录"), AutoFocus: true,
						OnSubmit: func(string) { a.addRemoteWorkspace() },
						StyleFunc: func() core.Style {
							return core.Style{Height: core.Pt(32), Padding: core.Symmetric(0, 10), CornerRadius: 7, Background: colors.Field(),
								BorderWidth: 1, BorderColor: colors.FieldBorder(), Color: colors.Text(), FontSize: 12.5, FontFamily: viewkit.MonoFont()}
						},
					},
				}},
			},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, OnPress: func() { a.addTarget.Set(false) }},
				ui.Button{Text: apptext.T("添加并开会话"), Variant: ui.ButtonPrimary, TestID: "target-add", OnPress: func() { a.addRemoteWorkspace() }},
			},
		}
	})
}
