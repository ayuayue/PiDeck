//go:build !js && !android && !ios

package workbench

// The window: a rail of projects and sessions, a bar of session tabs, the
// chat, and a drawer for the session's numbers and the project's files.

import (
	"fmt"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// drawerPanel is the right panel: the session's numbers and the project's files.
func (a *app) drawerPanel() core.Node {
	colors := ui.ColorsOf(a.cx)
	tab := func(name, label string) core.Node {
		on := func() bool { return a.drawerTab.Get() == name }
		return core.View{
			OnPress: func(core.PressEvent) {
				if a.drawerTab.Get() != name {
					a.animateNextLayout()
				}
				a.setDrawerTab(name)
				if name == "git" {
					a.gitAttach()
				}
			},
			Role: core.RoleTab, Label: label, TestID: "drawer-tab-" + name,
			StyleFunc: func() core.Style {
				st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, Height: core.Pt(26), Padding: core.Symmetric(0, 10),
					CornerRadius: 6, Transition: viewkit.PressMotion, Hover: &core.Style{Background: colors.Hover()},
					Active: &core.Style{Background: colors.Pressed()}}
				if on() {
					st.Background = colors.Surface()
					st.BorderWidth = 1
					st.BorderColor = colors.Border()
				}
				return st
			},
			Children: append([]core.Node{core.Text{Content: label, Style: core.Style{FontSize: 12},
				StyleFunc: func() core.Style {
					w := ui.Regular
					if on() {
						w = ui.Semibold
					}
					return core.Style{Color: colors.Text(), FontWeight: w}
				}}}, func() []core.Node {
				if name != "git" {
					return nil
				}
				return []core.Node{core.Dynamic(func(*core.Scope) core.Node {
					n := len(a.git.state.Get().Files)
					if n == 0 {
						return nil
					}
					return core.View{Style: core.Style{MinWidth: core.Pt(15), Height: core.Pt(15), Padding: core.Symmetric(0, 4),
						CornerRadius: 8, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Background: colors.Inset()},
						Children: []core.Node{ui.Text(fmt.Sprint(n), 8.5, ui.Medium, colors.Faint)}}
				})}
			}()...),
		}
	}
	return core.View{Style: core.Style{Padding: core.All(12), Gap: 10, Width: core.Pct(100),
		FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), Direction: core.Column}, Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4}, Children: []core.Node{
			tab("overview", apptext.T("概览")),
			tab("files", apptext.T("文件")),
			tab("git", "Git"),
			core.View{Style: core.Style{FlexGrow: 1}},
			core.Show{When: func() bool { return a.drawerTab.Get() == "files" }, Then: func(cx *core.Scope) core.Node {
				return core.View{Style: core.Style{Direction: core.Row, Gap: 2}, Children: []core.Node{
					hintOf(func() string { return apptext.T("刷新文件") }, ui.IconButton{Icon: lucide.RefreshCw, Label: apptext.T("刷新文件"), Size: 26, IconSize: 12.5, OnPress: func() { a.files.reload() }}),
					hintOf(func() string { return apptext.T("显示隐藏文件") }, ui.IconButton{Icon: lucide.Eye, Label: apptext.T("显示隐藏文件"), Size: 26, IconSize: 12.5, OnPress: func() { a.files.setHidden(!a.files.hidden.Get()) }}),
				}}
			}},
		}},
		core.View{Style: ui.FillRest, Children: []core.Node{
			core.Dynamic(func(cx *core.Scope) core.Node {
				switch a.drawerTab.Get() {
				case "files":
					return a.drawerFiles()
				case "git":
					return a.drawerGit()
				default:
					return a.drawerOverview()
				}
			}),
		}},
	}}
}
