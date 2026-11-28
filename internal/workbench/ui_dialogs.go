//go:build !js && !android && !ios

package workbench

// The window: a rail of projects and sessions, a bar of session tabs, the
// chat, and a drawer for the session's numbers and the project's files.

import (
	"runtime"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// appearanceButton is one choice of the settings' look.
func (a *app) appearanceButton(label, value string) core.Node {
	colors := ui.ColorsOf(a.cx)
	on := func() bool { return a.theme.Get() == value }
	return core.View{
		OnPress: func(core.PressEvent) { a.setTheme(value) },
		Role:    core.RoleRadio, Label: label,
		StyleFunc: func() core.Style {
			st := core.Style{Height: core.Pt(30), Padding: core.Symmetric(0, 12), CornerRadius: 7, Direction: core.Row,
				AlignItems: core.AlignCenter, BorderWidth: 1, BorderColor: colors.Border(), Hover: &core.Style{Background: colors.Hover()}}
			if on() {
				st.Background = colors.Pressed()
				st.BorderColor = colors.Text()
			}
			return st
		},
		Children: []core.Node{ui.Textf(func() string {
			if on() {
				return "✓ " + label
			}
			return label
		}, 12.5, ui.Regular, colors.Text)},
	}
}

// renameDialog names the session being renamed.
func (a *app) renameDialog() core.Node {
	colors := ui.ColorsOf(a.cx)
	return ui.Dialog{
		Open:         a.renameOpen.Get,
		OnOpenChange: func(open bool, _ base.Reason) { a.renameOpen.Set(open) },
		Title:        apptext.T("重命名会话"),
		TestID:       "rename",
		Children: []core.Node{core.Input{
			Value: a.renameText.Get, OnChange: a.renameText.Set, Placeholder: apptext.T("会话名称"), Label: apptext.T("会话名称"), AutoFocus: true,
			OnSubmit: func(string) { a.rename() },
			StyleFunc: func() core.Style {
				return core.Style{Height: core.Pt(34), Padding: core.Symmetric(0, 10), CornerRadius: 7, Background: colors.Field(),
					BorderWidth: 1, BorderColor: colors.FieldBorder(), Color: colors.Text(), FontSize: 13}
			},
		}},
		Footer: []core.Node{
			ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, TestID: "rename-cancel", OnPress: func() { a.renameOpen.Set(false) }},
			ui.Button{Text: apptext.T("重命名"), Variant: ui.ButtonPrimary, TestID: "rename-ok", OnPress: func() { a.rename() }},
		},
	}
}

// confirmDialog asks before something permanent.
func (a *app) confirmDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		primary := a.confirmPrimary
		tone, tint, icon := colors.Danger(), colors.Danger, lucide.TriangleAlert
		if primary {
			tone, tint, icon = colors.Accent(), colors.Accent, lucide.Blocks
		}
		return ui.Dialog{
			Open:         a.confirmOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.confirmOpen.Set(open) },
			TestID:       "confirm",
			Style:        core.Style{Width: core.Pt(380)},
			Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10}, Children: []core.Node{
					core.View{StyleFunc: func() core.Style {
						return core.Style{Width: core.Pt(30), Height: core.Pt(30), CornerRadius: 8, FlexShrink: 0,
							Background: ui.Alpha(tone, 0.10), AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter}
					}, Children: []core.Node{ui.Icon(icon, 15, tint)}},
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 2}, Children: []core.Node{
						core.Text{ContentFunc: func() string { return a.confirmHead.Get() },
							Style: core.Style{FontSize: 14, FontWeight: ui.Semibold, LineHeight: 20}, StyleFunc: ui.Colored(colors.Text)},
						core.Show{When: func() bool { return !a.confirmPrimary }, Then: func(*core.Scope) core.Node {
							return core.Text{ContentFunc: func() string { return a.confirmWhy.Get() + apptext.T("后无法撤销") },
								Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Faint)}
						}},
					}},
				}},
				core.View{StyleFunc: func() core.Style {
					return core.Style{Padding: core.Symmetric(10, 12), CornerRadius: 8, Background: colors.Inset(),
						BorderWidth: 1, BorderColor: colors.Now().Line}
				}, Children: []core.Node{
					core.Text{ContentFunc: func() string { return a.confirmBody.Get() },
						Style: core.Style{FontSize: 12.5, LineHeight: 19}, StyleFunc: ui.Colored(colors.Text)},
				}},
			},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, TestID: "confirm-cancel", OnPress: func() { a.confirmOpen.Set(false) }},
				ui.Button{Text: a.confirmWhy.Get(), Variant: ui.ButtonPrimary, TestID: "confirm-ok",
					Color: func() core.Color {
						if a.confirmPrimary {
							return colors.Accent()
						}
						return colors.Danger()
					},
					OnPress: func() { a.confirm() }},
			},
		}
	})
}

// modKey names the platform's shortcut modifier for labels.
func modKey() string {
	if runtime.GOOS == "darwin" {
		return "⌘"
	}
	return "Ctrl+"
}

// panelFieldStyle is a form field inside a pane: the surface, hairline and
// measure every editor shares, so the panes' fields line up.
func panelFieldStyle(colors ui.Colors) core.Style {
	return core.Style{MinHeight: core.Pt(34), Padding: core.Symmetric(6, 10), CornerRadius: ui.RadiusControl,
		Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder(), Color: colors.Text(), FontSize: 13}
}
