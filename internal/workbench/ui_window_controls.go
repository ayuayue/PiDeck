//go:build !js && !android && !ios

package workbench

// The window's own buttons. Windows and Linux draw the system's caption in a
// strip the app does not paint, which reads as faint beside a header that has
// its own hover states; there the app hides them and draws three buttons of
// its own at the header's end. macOS keeps its traffic lights, which belong
// to the platform's look.

import (
	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/desktop"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// ownWindowControls says whether the app draws the window's buttons itself.
func ownWindowControls(cx *core.Scope) bool {
	env := cx.Env()
	if env.Simulated() || !env.Desktop() {
		return false
	}
	switch env.OS() {
	case core.OSWindows, core.OSLinux:
		return true
	}
	return false
}

// hideSystemWindowControls takes the platform's caption buttons away where the
// app draws its own, and lets it keep them everywhere else.
func hideSystemWindowControls(cx *core.Scope) {
	if !ownWindowControls(cx) || !desktop.IsAvailable(cx) {
		return
	}
	desktop.SetWindowControls(cx, desktop.WindowControls{Hidden: true})
}

// windowControls are minimize, maximize or restore, and close, at the
// header's end: the same hover and press states as the rest of the chrome.
func (a *app) windowControls() core.Node {
	cx := a.cx
	if !ownWindowControls(cx) {
		return nil
	}
	colors := ui.ColorsOf(cx)
	maximized := func() bool { return cx.Env().Maximized() }
	button := func(icon func() *core.SVG, label, testID string, close bool, press func()) core.Node {
		return core.View{
			OnPress: func(core.PressEvent) { press() },
			Role:    core.RoleButton, Label: apptext.T(label), TestID: testID,
			StyleFunc: func() core.Style {
				hover := core.Style{Background: colors.Hover()}
				if close {
					hover.Background = ui.Alpha(colors.Danger(), 0.16)
				}
				return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter,
					Width: core.Pt(34), Height: core.Pt(28), CornerRadius: 6, Transition: viewkit.PressMotion,
					Hover: &hover, Active: &core.Style{Background: colors.Pressed()}}
			},
			Children: []core.Node{ui.IconOf(icon, 12.5, func() core.Color {
				if close {
					return colors.Text()
				}
				return colors.Muted()
			})},
		}
	}
	return core.View{TestID: "window-controls", Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 2,
		FlexShrink: 0, Margin: core.Edges{Left: 4}}, Children: []core.Node{
		button(lucide.Minus, "最小化窗口", "window-minimize", false, func() { desktop.MinimizeWindow(cx) }),
		core.Dynamic(func(*core.Scope) core.Node {
			if maximized() {
				return button(lucide.Copy, "向下还原窗口", "window-restore", false, func() { desktop.ToggleMaximize(cx) })
			}
			return button(lucide.Square, "最大化窗口", "window-maximize", false, func() { desktop.ToggleMaximize(cx) })
		}),
		button(lucide.X, "关闭窗口", "window-close", true, func() { desktop.CloseWindow(cx) }),
	}}
}
