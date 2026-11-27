//go:build !js && !android && !ios

package workbench

// The window: a rail of projects and sessions, a bar of session tabs, the
// chat, and a drawer for the session's numbers and the project's files.

import (
	"fmt"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// drawerPanel is the right panel: the session's numbers and the project's files.
func (a *app) drawerPanel() core.Node {
	colors := ui.ColorsOf(a.cx)
	gitLabel := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4}, Children: []core.Node{
		core.Text{Content: "Git", MaxLines: 1},
		core.Dynamic(func(*core.Scope) core.Node {
			n := len(a.git.state.Get().Files)
			if n == 0 {
				return nil
			}
			return core.View{Style: core.Style{MinWidth: core.Pt(20), Height: core.Pt(20), Padding: core.Symmetric(0, 6),
				CornerRadius: 6, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Background: colors.Inset()},
				Children: []core.Node{ui.Text(fmt.Sprint(n), viewkit.PanelMicroSize, ui.Medium, colors.Muted)}}
		}),
	}}
	return core.View{Style: core.Style{Padding: core.All(viewkit.PanelInset), Gap: viewkit.PanelGap, Width: core.Pct(100),
		FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), Direction: core.Column}, Children: []core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4}, Children: []core.Node{
			ui.Tabs[string]{Variant: ui.TabsUnderline, Size: ui.SizeDefault, Equal: true, Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)},
				Label: apptext.T("会话面板"), TestID: "drawer-tabs", Value: a.drawerTab.Get,
				Options: []ui.Option[string]{
					{Value: "overview", Label: apptext.T("概览"), TestID: "drawer-tab-overview"},
					{Value: "files", Label: apptext.T("文件"), TestID: "drawer-tab-files"},
					{Value: "git", Label: "Git", Content: gitLabel, TestID: "drawer-tab-git"},
				},
				OnChange: func(name string) {
					a.setDrawerTab(name)
					if name == "git" {
						a.gitAttach()
					}
				}},

			hintOf(func() string { return apptext.T("收起") }, ui.IconButton{Icon: lucide.X, Label: apptext.T("收起"), Size: viewkit.PanelControlSize, IconSize: viewkit.PanelIconSize,
				TestID: "drawer-close", OnPress: a.toggleDrawer}),
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
